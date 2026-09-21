import type { AgentStatusUpdate } from "../agent/agent-status.js";
import type { ChatToolDefinition } from "../models/model-chat.js";
import { randomUUID } from "node:crypto";
import {
  ArtifactRegistry,
  type ArtifactRecord,
} from "./artifact-registry.js";
import {
  ToolExecutionLogger,
  type ToolExecutionLogContext,
} from "./tool-execution-log.js";
import type { SandboxPolicy } from "../workspace/sandbox-policy.js";
import type { FileReadSnapshot } from "./file-write-utils.js";
import {
  resolveToolMetadata,
  type ResolvedToolMetadata,
  type ToolInterruptBehavior,
  type ToolMetadata,
} from "./tool-contract.js";
import {
  validateToolSchema,
  type ToolValidationResult,
} from "./tool-preflight.js";
import {
  DefaultPermissionCoordinator,
  type PermissionCoordinator,
  type PermissionCoordinatorOptions,
  type PermissionRequest,
} from "./permission-coordinator.js";
import type {
  PermissionDecision,
  ToolHookResult,
  ToolHooks,
} from "./tool-contract.js";
import {
  normalizeHarnessError,
  type HarnessError,
} from "../harness/index.js";

/** Per-call context handed to a tool handler so it can stream live events up. */
export interface ToolCallContext {
  /** Emit a subagent status update to the parent AgentLoop (and onward to UI). */
  emitAgentStatus?: (update: AgentStatusUpdate) => void;
  /** Correlation fields written to the tool execution log. */
  runId?: string;
  turn?: number;
  toolCallId?: string;
  taskId?: string;
  signal?: AbortSignal;
  artifacts?: ArtifactRegistry;
  emitProgress?: (progress: ToolProgress) => void;
  emitLifecycle?: (event: ToolLifecycleEvent) => void;
  queued?: boolean;
  registerArtifacts?: (paths: string[]) => ArtifactRecord[];
  markArtifactsReady?: (paths: string[]) => ArtifactRecord[];
  markArtifactsMissing?: (paths: string[], error?: string) => ArtifactRecord[];
  sandbox?: SandboxPolicy;
  recordFileRead?: (snapshot: FileReadSnapshot) => void;
  getFileReadSnapshot?: (path: string) => FileReadSnapshot | undefined;
  toolName?: string;
  toolMetadata?: ResolvedToolMetadata;
}

export type ToolTaskStatus = "completed" | "failed";

export interface ToolError {
  code:
    | "unknown_tool"
    | "invalid_json"
    | "invalid_input"
    | "policy_denied"
    | "permission_denied"
    | "execution_failed"
    | "output_invalid"
    | "cancelled"
    | "timeout";
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ToolLifecycleStage =
  | "tool_resolved"
  | "tool_validating"
  | "tool_normalizing"
  | "tool_normalized"
  | "pre_tool_hook"
  | "sandbox_check"
  | "policy_check"
  | "permission_decision"
  | "tool_artifact_preflight"
  | "tool_queued"
  | "tool_started"
  | "tool_completed"
  | "post_tool_hook"
  | "failure_hook"
  | "tool_failed";

export interface ToolLifecycleEvent {
  taskId?: string;
  stage: ToolLifecycleStage;
  ok: boolean;
  detail?: string;
}

export interface ToolProgress {
  taskId?: string;
  phase: "starting" | "running" | "verifying_outputs" | "completed" | "failed";
  elapsedMs?: number;
  message?: string;
  stdoutTail?: string;
  stderrTail?: string;
  outputPaths?: string[];
  missingOutputPaths?: string[];
}

export type ToolHandler = (args: unknown, context?: ToolCallContext) => Promise<string>;

export interface ToolRegistrationOptions extends ToolMetadata<unknown> {
  /**
   * Whether this tool may run in parallel with other concurrency-safe tools
   * for the given parsed arguments. Omit (or return false) for tools with
   * side effects or ordering dependencies — they execute exclusively.
  */
  producesArtifacts?: (args: unknown, context?: ToolCallContext) => string[];
  normalizeInput?: (
    input: unknown,
    context: ToolCallContext,
  ) => unknown | Promise<unknown>;
  validateInput?: (
    input: unknown,
    context: ToolCallContext,
  ) => ToolValidationResult | Promise<ToolValidationResult>;
}

export interface ToolRegistryOptions {
  logger?: ToolExecutionLogger;
  sandbox?: () => SandboxPolicy;
  permissionCoordinator?: PermissionCoordinator;
  permission?: Omit<PermissionCoordinatorOptions, "sandbox">;
}

export interface ToolExecutionOutcome {
  ok: boolean;
  content: string;
  taskId: string;
  status: ToolTaskStatus;
  preventContinuation?: boolean;
  hookContext?: string[];
  harnessError?: HarnessError;
}

interface RegisteredTool {
  definition: ChatToolDefinition;
  handler: ToolHandler;
  metadata: ToolRegistrationOptions;
  producesArtifacts?: (args: unknown, context?: ToolCallContext) => string[];
}

/**
 * Minimal tool registry shared by the Agent Loop. Handlers own their own
 * validation and throw Error on bad input; execute() converts that into the
 * tool-error result sent back to the model.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly aliases = new Map<string, string>();
  private readonly fileReadSnapshots = new Map<string, FileReadSnapshot>();
  readonly artifacts: ArtifactRegistry;
  private readonly permissionCoordinator: PermissionCoordinator;

  constructor(
    private readonly options: ToolRegistryOptions = {},
    artifacts?: ArtifactRegistry,
  ) {
    this.artifacts = artifacts ?? new ArtifactRegistry();
    this.permissionCoordinator =
      options.permissionCoordinator ??
      new DefaultPermissionCoordinator(options.permission);
  }

  register(
    definition: ChatToolDefinition,
    handler: ToolHandler,
    options: ToolRegistrationOptions = {},
  ): void {
    this.tools.set(definition.function.name, {
      definition,
      handler,
      metadata: options,
      producesArtifacts: options.producesArtifacts,
    });
    for (const alias of options.aliases ?? []) {
      if (alias && alias !== definition.function.name) {
        this.aliases.set(alias, definition.function.name);
      }
    }
  }

  has(name: string): boolean {
    return Boolean(this.resolveTool(name));
  }

  definitions(): ChatToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  /**
   * Concurrency verdict for a tool call. Undeclared, unknown, or unparseable
   * calls are treated as NOT concurrency-safe (exclusive) — the conservative
   * default. Mirrors Claude Code's StreamingToolExecutor.isConcurrencySafe.
   */
  isConcurrencySafe(name: string, argumentsText: string): boolean {
    return this.describeCall(name, argumentsText).concurrencySafe;
  }

  describeCall(name: string, argumentsText: string): ResolvedToolMetadata {
    const tool = this.resolveTool(name);
    if (!tool) return resolveToolMetadata(name, {}, undefined);

    try {
      return resolveToolMetadata(
        tool.definition.function.name,
        parseToolArguments(argumentsText),
        tool.metadata,
      );
    } catch {
      return resolveToolMetadata(
        tool.definition.function.name,
        {},
        tool.metadata,
      );
    }
  }

  getInterruptBehavior(name: string, argumentsText: string): ToolInterruptBehavior {
    return this.describeCall(name, argumentsText).interruptBehavior;
  }

  async execute(
    name: string,
    argumentsText: string,
    context?: ToolCallContext,
  ): Promise<ToolExecutionOutcome> {
    const executionId = randomUUID();
    const taskId = `tool-${executionId}`;
    const startedAt = Date.now();
    const tool = this.resolveTool(name);
    const executionName = tool?.definition.function.name ?? name;
    const logContext: ToolExecutionLogContext = {
      runId: context?.runId,
      turn: context?.turn,
      toolCallId: context?.toolCallId,
      taskId,
    };
    const emitProgress = (progress: ToolProgress): void => {
      const enriched: ToolProgress = { ...progress, taskId };
      void this.options.logger?.record(
        ToolExecutionLogger.createProgressEvent(
          executionId,
          executionName,
          enriched,
          logContext,
        ),
      );
      context?.emitProgress?.(enriched);
    };
    const executionContext: ToolCallContext = {
      ...context,
      taskId,
      toolName: executionName,
      signal: context?.signal ?? new AbortController().signal,
      artifacts: this.artifacts,
      sandbox: context?.sandbox ?? this.options.sandbox?.(),
      recordFileRead: (snapshot) => {
        this.fileReadSnapshots.set(normalizePath(snapshot.path), snapshot);
      },
      getFileReadSnapshot: (path) =>
        this.fileReadSnapshots.get(normalizePath(path)),
      emitProgress,
      registerArtifacts: (paths) => {
        const records = this.artifacts.registerPending(paths, taskId);
        if (records.length > 0) {
          void this.options.logger?.record(
            ToolExecutionLogger.createArtifactEvent(
              executionId,
              executionName,
              "pending",
              records.map((record) => record.path),
              logContext,
            ),
          );
        }
        return records;
      },
      markArtifactsReady: (paths) => {
        const records = this.artifacts.markReady(paths);
        if (records.length > 0) {
          void this.options.logger?.record(
            ToolExecutionLogger.createArtifactEvent(
              executionId,
              executionName,
              "ready",
              records.map((record) => record.path),
              logContext,
            ),
          );
        }
        return records;
      },
      markArtifactsMissing: (paths, error) => {
        const records = this.artifacts.markMissing(paths, error);
        if (records.length > 0) {
          void this.options.logger?.record(
            ToolExecutionLogger.createArtifactEvent(
              executionId,
              executionName,
              "missing",
              records.map((record) => record.path),
              logContext,
              error,
            ),
          );
        }
        return records;
      },
    };
    let args: unknown;

    try {
      args = parseToolArguments(argumentsText);
    } catch {
      const content = `Tool error: invalid JSON arguments for ${name}.`;
      const harnessError = normalizeHarnessError(content, {
        code: "invalid_json",
        category: "invalid_input",
        layer: "tool",
        phase: "parsing",
        scope: "tool",
        recovery: "repair_input",
        sideEffect: "none",
      });
      await this.options.logger?.record(
        ToolExecutionLogger.createStartEvent(
          executionId,
          executionName,
          argumentsText,
          undefined,
          logContext,
        ),
      );
      await this.options.logger?.record(
        ToolExecutionLogger.createHarnessErrorEvent(
          executionId,
          executionName,
          harnessError,
          logContext,
        ),
      );
      await this.options.logger?.record(
        ToolExecutionLogger.createFinishEvent(
          executionId,
          executionName,
          false,
          Date.now() - startedAt,
          content,
          logContext,
          "failed",
        ),
      );
      return { ok: false, content, taskId, status: "failed", harnessError };
    }

    let metadata = tool
      ? resolveToolMetadata(executionName, args, tool.metadata)
      : resolveToolMetadata(executionName, args, undefined);
    executionContext.toolMetadata = metadata;

    await this.options.logger?.record(
      ToolExecutionLogger.createStartEvent(
        executionId,
        executionName,
        argumentsText,
        args,
        logContext,
        metadata,
      ),
    );

    const recordLifecycle = (
      stage: ToolLifecycleStage,
      ok = true,
      detail?: string,
      decision?: PermissionDecision,
      audit?: Record<string, unknown>,
    ): Promise<void> =>
      Promise.all([
        this.options.logger?.record(
          ToolExecutionLogger.createLifecycleEvent(
            executionId,
            executionName,
            stage,
            logContext,
            ok,
            detail,
            decision,
            audit,
          ),
        ) ?? Promise.resolve(),
        Promise.resolve(
          executionContext.emitLifecycle?.({
            taskId,
            stage,
            ok,
            ...(detail ? { detail } : {}),
          }),
        ),
      ]).then(() => undefined);

    if (context?.queued) {
      await recordLifecycle("tool_queued");
    }

    const hookContext: string[] = [];
    let preventContinuation = false;
    const applyHookResult = (result: ToolHookResult | undefined): void => {
      if (!result) return;
      if (result.additionalContext?.trim()) {
        hookContext.push(result.additionalContext.trim());
      }
      if (result.preventContinuation) {
        preventContinuation = true;
      }
    };

    const invokeErrorHook = async (error: ToolError): Promise<void> => {
      const hook = tool?.metadata.hooks?.onError;
      if (!hook) return;
      await recordLifecycle("failure_hook");
      try {
        const result = await hook(error, executionContext);
        applyHookResult(result);
        await recordLifecycle(
          "failure_hook",
          result.decision !== "block",
          result.stopReason ?? result.additionalContext,
          undefined,
          result.audit,
        );
      } catch (hookError) {
        hookContext.push(
          `Failure hook error: ${
            hookError instanceof Error ? hookError.message : String(hookError)
          }`,
        );
      }
    };

    const failPreflight = async (
      stage: ToolLifecycleStage,
      detail: string,
      code: ToolError["code"] = "invalid_input",
    ): Promise<ToolExecutionOutcome> => {
      const harnessError = normalizeHarnessError(detail, {
        code,
        layer: "tool",
        phase: stage,
        scope: "tool",
        details: { tool: executionName },
      });
      await recordLifecycle(stage, false, detail);
      await invokeErrorHook({
        code,
        message: detail,
        retryable: code === "invalid_input",
      });
      const content = `Tool error: ${detail}`;
      const finalContent = appendHookContext(content, hookContext);
      await this.options.logger?.record(
        ToolExecutionLogger.createFinishEvent(
          executionId,
          executionName,
          false,
          Date.now() - startedAt,
          finalContent,
          logContext,
          "failed",
        ),
      );
      await this.options.logger?.record(
        ToolExecutionLogger.createHarnessErrorEvent(
          executionId,
          executionName,
          harnessError,
          logContext,
        ),
      );
      return {
        ok: false,
        content: finalContent,
        taskId,
        status: "failed",
        harnessError,
        ...(preventContinuation ? { preventContinuation: true } : {}),
        ...(hookContext.length > 0 ? { hookContext: [...hookContext] } : {}),
      };
    };

    if (!tool) {
      return failPreflight(
        "tool_resolved",
        `unknown tool "${name}".`,
      );
    }
    await recordLifecycle("tool_resolved");

    await recordLifecycle("tool_validating");
    const schemaResult = validateToolSchema(
      tool.definition.function.parameters,
      args,
    );
    if (!schemaResult.ok) {
      return failPreflight(
        "tool_validating",
        `invalid input for ${executionName}: ${schemaResult.errors.join("; ")}`,
      );
    }

    let preparedArgs = args;
    if (tool.metadata.normalizeInput) {
      try {
        await recordLifecycle("tool_normalizing");
        preparedArgs = await tool.metadata.normalizeInput(
          preparedArgs,
          executionContext,
        );
      } catch (error) {
        return failPreflight(
          "tool_normalizing",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const normalizedSchemaResult = validateToolSchema(
      tool.definition.function.parameters,
      preparedArgs,
    );
    if (!normalizedSchemaResult.ok) {
      return failPreflight(
        "tool_validating",
        `normalized input for ${executionName} is invalid: ${
          normalizedSchemaResult.errors.join("; ")
        }`,
      );
    }

    if (tool.metadata.validateInput) {
      let validationResult: ToolValidationResult;
      try {
        validationResult = await tool.metadata.validateInput(
          preparedArgs,
          executionContext,
        );
      } catch (error) {
        return failPreflight(
          "tool_validating",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!validationResult.ok) {
        return failPreflight(
          "tool_validating",
          validationResult.errors.join("; ") || `invalid input for ${executionName}`,
        );
      }
      if (validationResult.normalizedInput !== undefined) {
        preparedArgs = validationResult.normalizedInput;
      }
    }

    const finalSchemaResult = validateToolSchema(
      tool.definition.function.parameters,
      preparedArgs,
    );
    if (!finalSchemaResult.ok) {
      return failPreflight(
        "tool_validating",
        `validated input for ${executionName} is invalid: ${
          finalSchemaResult.errors.join("; ")
        }`,
      );
    }

    args = preparedArgs;
    metadata = resolveToolMetadata(executionName, args, tool.metadata);
    executionContext.toolMetadata = metadata;
    await recordLifecycle("tool_normalized");

    if (metadata.hooks?.beforeExecute) {
      await recordLifecycle("pre_tool_hook");
      try {
        const hookResult = await metadata.hooks.beforeExecute(
          args,
          executionContext,
        );
        applyHookResult(hookResult);
        await recordLifecycle(
          "pre_tool_hook",
          hookResult.decision !== "block",
          hookResult.stopReason ?? hookResult.additionalContext,
          undefined,
          hookResult.audit,
        );
        if (hookResult.decision === "block") {
          return failPreflight(
            "pre_tool_hook",
            hookResult.stopReason ?? "PreToolUse hook blocked execution.",
            "policy_denied",
          );
        }
        if (hookResult.updatedInput !== undefined) {
          const hookInput = hookResult.updatedInput;
          const hookSchemaResult = validateToolSchema(
            tool.definition.function.parameters,
            hookInput,
          );
          if (!hookSchemaResult.ok) {
            return failPreflight(
              "pre_tool_hook",
              `PreToolUse hook produced invalid input: ${
                hookSchemaResult.errors.join("; ")
              }`,
              "invalid_input",
            );
          }
          args = hookInput;
          metadata = resolveToolMetadata(executionName, args, tool.metadata);
          executionContext.toolMetadata = metadata;
        }
      } catch (error) {
        return failPreflight(
          "pre_tool_hook",
          error instanceof Error ? error.message : String(error),
          "policy_denied",
        );
      }
    }

    let producedArtifacts: string[] = [];
    try {
      producedArtifacts = tool?.producesArtifacts?.(args, executionContext) ?? [];
    } catch (error) {
      const content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      const harnessError = normalizeHarnessError(error, {
        code: "artifact_preflight_failed",
        layer: "tool",
        phase: "tool_artifact_preflight",
        scope: "tool",
        details: { tool: executionName },
      });
      await invokeErrorHook({
        code: "invalid_input",
        message: content,
        retryable: true,
      });
      const finalContent = appendHookContext(content, hookContext);
      await this.options.logger?.record(
        ToolExecutionLogger.createFinishEvent(
          executionId,
          executionName,
          false,
          Date.now() - startedAt,
          finalContent,
          logContext,
          "failed",
        ),
      );
      await this.options.logger?.record(
        ToolExecutionLogger.createHarnessErrorEvent(
          executionId,
          executionName,
          harnessError,
          logContext,
        ),
      );
      return {
        ok: false,
        content: finalContent,
        taskId,
        status: "failed",
        harnessError,
        ...(preventContinuation ? { preventContinuation: true } : {}),
        ...(hookContext.length > 0 ? { hookContext: [...hookContext] } : {}),
      };
    }

    let readPaths: string[];
    let writePaths: string[];
    try {
      readPaths = resolvePermissionPaths(
        metadata.readPaths ?? (metadata.readOnly ? metadata.paths ?? [] : []),
        executionContext.sandbox,
        "read",
      );
      writePaths = resolvePermissionPaths(
        metadata.writePaths ?? [],
        executionContext.sandbox,
        "write",
      ).concat(
        resolvePermissionPaths(
          producedArtifacts,
          executionContext.sandbox,
          "write",
        ),
      );
    } catch (error) {
      return failPreflight(
        "sandbox_check",
        error instanceof Error ? error.message : String(error),
        "permission_denied",
      );
    }
    await recordLifecycle("sandbox_check");
    await recordLifecycle("policy_check");
    let permission: PermissionDecision;
    try {
      permission = await this.permissionCoordinator.evaluate({
        toolName: executionName,
        input: args,
        metadata,
        readPaths,
        writePaths,
        context: executionContext,
      } satisfies PermissionRequest);
    } catch (error) {
      return failPreflight(
        "permission_decision",
        error instanceof Error ? error.message : String(error),
        "permission_denied",
      );
    }
    await recordLifecycle(
      "permission_decision",
      permission.action === "allow",
      permission.reason,
      permission,
    );
    if (permission.action !== "allow") {
      return failPreflight(
        "permission_decision",
        permission.reason ?? `Permission ${permission.action} for ${executionName}.`,
        "permission_denied",
      );
    }

    await recordLifecycle("tool_artifact_preflight");
    if (producedArtifacts.length > 0) {
      this.artifacts.registerPending(producedArtifacts, taskId);
      void this.options.logger?.record(
        ToolExecutionLogger.createArtifactEvent(
          executionId,
          executionName,
          "pending",
          producedArtifacts,
          logContext,
        ),
      );
    }

    try {
      emitProgress({
        phase: "starting",
        message: metadata.activityDescription ?? `Starting ${executionName}`,
      });
      await recordLifecycle("tool_started");
      const rawContent = await tool.handler(args, executionContext);
      const { content, truncated } = limitToolResult(
        rawContent,
        metadata.maxResultSizeChars,
      );
      let finalContent = appendHookContext(content, hookContext);
      const baseOutcome: ToolExecutionOutcome = {
        ok: true,
        content: finalContent,
        taskId,
        status: "completed",
      };
      await recordLifecycle("tool_completed");
      if (metadata.hooks?.afterExecute) {
        await recordLifecycle("post_tool_hook");
        try {
          const hookResult = await metadata.hooks.afterExecute(
            baseOutcome,
            executionContext,
          );
          applyHookResult(hookResult);
          await recordLifecycle(
            "post_tool_hook",
            hookResult.decision !== "block",
            hookResult.stopReason ?? hookResult.additionalContext,
            undefined,
            hookResult.audit,
          );
          if (hookResult.decision === "block") {
            hookContext.push(
              hookResult.stopReason ?? "PostToolUse hook marked the result as blocked.",
            );
          }
        } catch (error) {
          await invokeErrorHook({
            code: "execution_failed",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          });
          hookContext.push(
            `PostToolUse hook error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        finalContent = appendHookContext(content, hookContext);
      }
      emitProgress({
        phase: "completed",
        elapsedMs: Date.now() - startedAt,
        message: `${executionName} completed`,
      });
      await this.options.logger?.record(
        ToolExecutionLogger.createFinishEvent(
          executionId,
          executionName,
          true,
          Date.now() - startedAt,
          finalContent,
          logContext,
          "completed",
          truncated,
        ),
      );
      return {
        ok: true,
        content: finalContent,
        taskId,
        status: "completed",
        ...(preventContinuation ? { preventContinuation: true } : {}),
        ...(hookContext.length > 0 ? { hookContext: [...hookContext] } : {}),
      };
    } catch (error) {
      const content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      const harnessError = normalizeHarnessError(error, {
        code: isAbortError(error) ? "cancelled" : "tool_execution_failed",
        layer: "tool",
        phase: "tool_runtime",
        scope: "tool",
        details: { tool: executionName },
      });
      await invokeErrorHook({
        code: isAbortError(error) ? "cancelled" : "execution_failed",
        message: content,
        retryable: !isAbortError(error),
      });
      const finalContent = appendHookContext(content, hookContext);
      const failedArtifacts = this.artifacts.markProducerFailed(taskId, content);
      if (failedArtifacts.length > 0) {
        void this.options.logger?.record(
          ToolExecutionLogger.createArtifactEvent(
            executionId,
            executionName,
            "missing",
          failedArtifacts.map((record) => record.path),
          logContext,
            finalContent,
          ),
        );
      }
      emitProgress({
        phase: "failed",
        elapsedMs: Date.now() - startedAt,
        message: content,
      });
      await recordLifecycle(
        "tool_failed",
        false,
        content,
      );
      await this.options.logger?.record(
        ToolExecutionLogger.createFinishEvent(
          executionId,
          executionName,
          false,
          Date.now() - startedAt,
          finalContent,
          logContext,
          "failed",
        ),
      );
      await this.options.logger?.record(
        ToolExecutionLogger.createHarnessErrorEvent(
          executionId,
          executionName,
          harnessError,
          logContext,
        ),
      );
      return {
        ok: false,
        content: finalContent,
        taskId,
        status: "failed",
        harnessError,
        ...(preventContinuation ? { preventContinuation: true } : {}),
        ...(hookContext.length > 0 ? { hookContext: [...hookContext] } : {}),
      };
    }
  }

  private resolveTool(name: string): RegisteredTool | undefined {
    const canonicalName = this.aliases.get(name) ?? name;
    return this.tools.get(canonicalName);
  }
}

function limitToolResult(
  content: string,
  maxResultSizeChars: number | undefined,
): { content: string; truncated: boolean } {
  if (!maxResultSizeChars || content.length <= maxResultSizeChars) {
    return { content, truncated: false };
  }

  return {
    content: [
      content.slice(0, maxResultSizeChars),
      "",
      `[Tool result truncated at ${maxResultSizeChars} characters.]`,
    ].join("\n"),
    truncated: true,
  };
}

function appendHookContext(content: string, updates: readonly string[]): string {
  if (updates.length === 0) return content;
  return [
    content,
    "",
    "[Harness hook context]",
    ...updates.map((update) => `- ${update}`),
  ].join("\n");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    error.message.toLowerCase().includes("aborted")
  );
}

function resolvePermissionPaths(
  paths: readonly string[],
  sandbox: SandboxPolicy | undefined,
  operation: "read" | "write",
): string[] {
  if (!sandbox) return [...paths];
  return paths.map((path) =>
    operation === "read"
      ? sandbox.resolveReadPath(path, sandbox.projectDir)
      : sandbox.resolveWritePath(path, sandbox.sandboxRoot),
  );
}

function normalizePath(path: string): string {
  return path.replace(/[\\/]+/gu, "\\").toLowerCase();
}

function parseToolArguments(argumentsText: string): unknown {
  const repaired = repairWindowsPathStringLiterals(argumentsText);
  if (repaired !== argumentsText) {
    try {
      return JSON.parse(repaired) as unknown;
    } catch {
      // Fall back to the original parse so ordinary JSON errors keep their normal path.
    }
  }
  return JSON.parse(argumentsText) as unknown;
}

function repairWindowsPathStringLiterals(jsonText: string): string {
  let repaired = "";
  let index = 0;

  while (index < jsonText.length) {
    const char = jsonText[index];
    if (char !== "\"") {
      repaired += char;
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    let content = "";
    while (index < jsonText.length) {
      const current = jsonText[index]!;
      if (current === "\"" && !isEscapedQuote(jsonText, index)) {
        break;
      }
      content += current;
      index += 1;
    }

    if (index >= jsonText.length) {
      repaired += jsonText.slice(start);
      break;
    }

    repaired += "\"" + repairWindowsPathLiteralContent(content) + "\"";
    index += 1;
  }

  return repaired;
}

function repairWindowsPathLiteralContent(content: string): string {
  if (!/[A-Za-z]:(?:\\|\/)/u.test(content) && !content.includes("\\\\")) {
    return content;
  }

  let repaired = "";
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (char !== "\\") {
      repaired += char;
      continue;
    }

    let end = index + 1;
    while (end < content.length && content[end] === "\\") end += 1;
    const run = content.slice(index, end);
    repaired += run.length === 1 ? "\\\\" : run;
    index = end - 1;
  }

  return repaired;
}

function isEscapedQuote(text: string, quoteIndex: number): boolean {
  let slashCount = 0;
  for (let index = quoteIndex - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}
