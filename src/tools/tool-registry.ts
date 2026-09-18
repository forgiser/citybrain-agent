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
  registerArtifacts?: (paths: string[]) => ArtifactRecord[];
  markArtifactsReady?: (paths: string[]) => ArtifactRecord[];
  markArtifactsMissing?: (paths: string[], error?: string) => ArtifactRecord[];
}

export type ToolTaskStatus = "completed" | "failed";

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

export interface ToolRegistrationOptions {
  /**
   * Whether this tool may run in parallel with other concurrency-safe tools
   * for the given parsed arguments. Omit (or return false) for tools with
   * side effects or ordering dependencies — they execute exclusively.
   */
  isConcurrencySafe?: (args: unknown) => boolean;
  producesArtifacts?: (args: unknown) => string[];
}

export interface ToolRegistryOptions {
  logger?: ToolExecutionLogger;
}

export interface ToolExecutionOutcome {
  ok: boolean;
  content: string;
  taskId: string;
  status: ToolTaskStatus;
}

interface RegisteredTool {
  definition: ChatToolDefinition;
  handler: ToolHandler;
  isConcurrencySafe?: (args: unknown) => boolean;
  producesArtifacts?: (args: unknown) => string[];
}

/**
 * Minimal tool registry shared by the Agent Loop. Handlers own their own
 * validation and throw Error on bad input; execute() converts that into the
 * tool-error result sent back to the model.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  readonly artifacts: ArtifactRegistry;

  constructor(
    private readonly options: ToolRegistryOptions = {},
    artifacts?: ArtifactRegistry,
  ) {
    this.artifacts = artifacts ?? new ArtifactRegistry();
  }

  register(
    definition: ChatToolDefinition,
    handler: ToolHandler,
    options: ToolRegistrationOptions = {},
  ): void {
    this.tools.set(definition.function.name, {
      definition,
      handler,
      isConcurrencySafe: options.isConcurrencySafe,
      producesArtifacts: options.producesArtifacts,
    });
  }

  has(name: string): boolean {
    return this.tools.has(name);
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
    const tool = this.tools.get(name);
    if (!tool?.isConcurrencySafe) return false;
    let args: unknown;
    try {
      args = parseToolArguments(argumentsText);
    } catch {
      return false;
    }
    try {
      return Boolean(tool.isConcurrencySafe(args));
    } catch {
      return false;
    }
  }

  async execute(
    name: string,
    argumentsText: string,
    context?: ToolCallContext,
  ): Promise<ToolExecutionOutcome> {
    const executionId = randomUUID();
    const taskId = `tool-${executionId}`;
    const startedAt = Date.now();
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
          name,
          enriched,
          logContext,
        ),
      );
      context?.emitProgress?.(enriched);
    };
    const executionContext: ToolCallContext = {
      ...context,
      taskId,
      signal: context?.signal ?? new AbortController().signal,
      artifacts: this.artifacts,
      emitProgress,
      registerArtifacts: (paths) => {
        const records = this.artifacts.registerPending(paths, taskId);
        if (records.length > 0) {
          void this.options.logger?.record(
            ToolExecutionLogger.createArtifactEvent(
              executionId,
              name,
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
              name,
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
              name,
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
    const tool = this.tools.get(name);
    let args: unknown;

    try {
      args = parseToolArguments(argumentsText);
    } catch {
      await this.options.logger?.record(
        ToolExecutionLogger.createStartEvent(
          executionId,
          name,
          argumentsText,
          undefined,
          logContext,
        ),
      );
      const content = `Tool error: invalid JSON arguments for ${name}.`;
      await this.options.logger?.record(
        ToolExecutionLogger.createFinishEvent(
          executionId,
          name,
          false,
          Date.now() - startedAt,
          content,
          logContext,
          "failed",
        ),
      );
      return { ok: false, content, taskId, status: "failed" };
    }

    const producedArtifacts = tool?.producesArtifacts?.(args) ?? [];
    if (producedArtifacts.length > 0) {
      this.artifacts.registerPending(producedArtifacts, taskId);
      void this.options.logger?.record(
        ToolExecutionLogger.createArtifactEvent(
          executionId,
          name,
          "pending",
          producedArtifacts,
          logContext,
        ),
      );
    }

    await this.options.logger?.record(
      ToolExecutionLogger.createStartEvent(
        executionId,
        name,
        argumentsText,
        args,
        logContext,
      ),
    );

    if (!tool) {
      const content = `Tool error: unknown tool "${name}".`;
      await this.options.logger?.record(
        ToolExecutionLogger.createFinishEvent(
          executionId,
          name,
          false,
          Date.now() - startedAt,
          content,
          logContext,
          "failed",
        ),
      );
      return { ok: false, content, taskId, status: "failed" };
    }

    try {
      emitProgress({
        phase: "starting",
        message: `Starting ${name}`,
      });
      const content = await tool.handler(args, executionContext);
      emitProgress({
        phase: "completed",
        elapsedMs: Date.now() - startedAt,
        message: `${name} completed`,
      });
      await this.options.logger?.record(
        ToolExecutionLogger.createFinishEvent(
          executionId,
          name,
          true,
          Date.now() - startedAt,
          content,
          logContext,
          "completed",
        ),
      );
      return { ok: true, content, taskId, status: "completed" };
    } catch (error) {
      const content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      const failedArtifacts = this.artifacts.markProducerFailed(taskId, content);
      if (failedArtifacts.length > 0) {
        void this.options.logger?.record(
          ToolExecutionLogger.createArtifactEvent(
            executionId,
            name,
            "missing",
            failedArtifacts.map((record) => record.path),
            logContext,
            content,
          ),
        );
      }
      emitProgress({
        phase: "failed",
        elapsedMs: Date.now() - startedAt,
        message: content,
      });
      await this.options.logger?.record(
        ToolExecutionLogger.createFinishEvent(
          executionId,
          name,
          false,
          Date.now() - startedAt,
          content,
          logContext,
          "failed",
        ),
      );
      return { ok: false, content, taskId, status: "failed" };
    }
  }
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
