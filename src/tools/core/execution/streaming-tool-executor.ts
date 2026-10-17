import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentStatusUpdate, SubagentTraceStep } from "../../../agent/agent-status.js";
import type { ChatToolCall } from "../../../models/model-chat.js";
import {
  ToolRegistry,
} from "./tool-registry.js";
import type {
  ToolExecutionOutcome,
  ToolLifecycleEvent,
  ToolProgress,
} from "../contracts/tool-types.js";
import type { ToolInterruptBehavior, ToolSource } from "../contracts/tool-contract.js";
import {
  normalizeHarnessError,
  type HarnessError,
  type HarnessRecoveryDecision,
} from "../../../harness/index.js";
import {
  TaskManager,
  type TaskExecutionContext,
  type TaskSnapshot,
} from "../../../task/index.js";

export interface ToolExecutionStarted {
  name: string;
  argumentsText: string;
  taskId?: string;
  toolCallId?: string;
  source?: ToolSource;
  readOnly?: boolean;
  destructive?: boolean;
  concurrencySafe?: boolean;
  interruptBehavior?: ToolInterruptBehavior;
  paths?: string[];
  activityDescription?: string;
  toolUseSummary?: string;
}

export interface ToolExecutionResult extends ToolExecutionStarted {
  ok: boolean;
  result: string;
  status?: ToolExecutionOutcome["status"];
}

export type StreamingToolEvent =
  | ({ type: "tool_started" } & ToolExecutionStarted)
  | ({ type: "tool_result" } & ToolExecutionResult)
  | {
      type: "tool_progress";
      name: string;
      argumentsText: string;
      taskId: string;
      toolCallId: string;
      progress: ToolProgress;
    }
  | {
      type: "tool_lifecycle";
      name: string;
      argumentsText: string;
      taskId: string;
      toolCallId: string;
      lifecycle: ToolLifecycleEvent;
    }
  | {
      type: "harness_error";
      name: string;
      argumentsText: string;
      taskId: string;
      toolCallId: string;
      error: HarnessError;
      decision?: HarnessRecoveryDecision;
    }
  | ({ type: "agent_status" } & AgentStatusUpdate)
  | { type: "subagent_event"; parentToolCallId: string; event: SubagentTraceStep };

export interface StreamingToolExecutorOptions {
  runId: string;
  turn: number;
  sessionId?: string;
  transientRun?: boolean;
  signal?: AbortSignal;
}

/**
 * Owns the tool lifecycle for one assistant tool-call batch.
 *
 * The model loop only consumes lifecycle events and the final outcomes. It
 * does not need to know how concurrency-safe and exclusive tools are queued.
 */
export class StreamingToolExecutor {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly taskManager?: TaskManager,
  ) {}

  async *execute(
    toolCalls: readonly ChatToolCall[],
    options: StreamingToolExecutorOptions,
  ): AsyncGenerator<StreamingToolEvent, ToolExecutionOutcome[], undefined> {
    const events: StreamingToolEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let runnerError: unknown;
    const settlements: Array<Promise<ToolExecutionOutcome>> = new Array(
      toolCalls.length,
    );
    const executing: Array<{
      safe: boolean;
      promise: Promise<ToolExecutionOutcome>;
    }> = [];
    let detachedExclusiveTaskId: string | undefined;

    const emit = (event: StreamingToolEvent): void => {
      events.push(event);
      const pending = wake;
      wake = undefined;
      pending?.();
    };

    const deferAfterBackground = (
      toolCall: ChatToolCall,
      index: number,
    ): boolean => {
      if (!detachedExclusiveTaskId) return false;
      const outcome = createDeferredByBackgroundOutcome(
        toolCall,
        detachedExclusiveTaskId,
      );
      emit({
        type: "tool_started",
        name: toolCall.name,
        argumentsText: toolCall.arguments,
        toolCallId: toolCall.id,
        activityDescription: "Deferred by background task",
      });
      emit({
        type: "tool_result",
        name: toolCall.name,
        argumentsText: toolCall.arguments,
        taskId: outcome.taskId,
        toolCallId: toolCall.id,
        ok: false,
        result: outcome.content,
        status: outcome.status,
      });
      settlements[index] = Promise.resolve(outcome);
      return true;
    };

    const start = (toolCall: ChatToolCall, index: number): void => {
      const metadata = this.tools.describeCall(toolCall.name, toolCall.arguments);
      const safe = metadata.concurrencySafe;
      emit({
        type: "tool_started",
        name: toolCall.name,
        argumentsText: toolCall.arguments,
        toolCallId: toolCall.id,
        source: metadata.source,
        readOnly: metadata.readOnly,
        destructive: metadata.destructive,
        concurrencySafe: metadata.concurrencySafe,
        interruptBehavior: metadata.interruptBehavior,
        paths: metadata.paths,
        activityDescription: metadata.activityDescription,
        toolUseSummary: metadata.toolUseSummary,
      });

      const context = {
        runId: options.runId,
        sessionId: options.sessionId,
        transientRun: options.transientRun,
        turn: options.turn,
        toolCallId: toolCall.id,
        signal: metadata.interruptBehavior === "cancel" ? options.signal : undefined,
        queued: true,
        emitAgentStatus: (update: AgentStatusUpdate) =>
          emit({ type: "agent_status", ...update }),
        emitSubagentEvent: (event: SubagentTraceStep) =>
          emit({ type: "subagent_event", parentToolCallId: toolCall.id, event }),
        emitProgress: (progress: ToolProgress) =>
          emit({
            type: "tool_progress",
            name: toolCall.name,
            argumentsText: toolCall.arguments,
            taskId: progress.taskId ?? toolCall.id,
            toolCallId: toolCall.id,
            progress,
          }),
        emitLifecycle: (lifecycle: ToolLifecycleEvent) =>
          emit({
            type: "tool_lifecycle",
            name: toolCall.name,
            argumentsText: toolCall.arguments,
            taskId: lifecycle.taskId ?? toolCall.id,
            toolCallId: toolCall.id,
            lifecycle,
          }),
      };

      const settlement = this.executeCall(toolCall, metadata, context, emit)
        .catch((error): ToolExecutionOutcome => {
          const harnessError = normalizeHarnessError(error, {
            code: "tool_executor_failure",
            layer: "tool",
            phase: "streaming_executor",
            scope: "tool",
            details: { tool: toolCall.name },
          });
          return {
            ok: false,
            content: `Tool error: ${harnessError.message}`,
            taskId: `tool-${randomUUID()}`,
            status: "failed",
            harnessError,
          };
        })
        .then((outcome) => {
          if (outcome.harnessError) {
            emit({
              type: "harness_error",
              name: toolCall.name,
              argumentsText: toolCall.arguments,
              taskId: outcome.taskId,
              toolCallId: toolCall.id,
              error: outcome.harnessError,
            });
          }
          emit({
            type: "tool_result",
            name: toolCall.name,
            argumentsText: toolCall.arguments,
            taskId: outcome.taskId,
            toolCallId: toolCall.id,
            ok: outcome.ok,
            result: outcome.content,
            status: outcome.status,
            source: metadata.source,
            readOnly: metadata.readOnly,
            destructive: metadata.destructive,
            concurrencySafe: metadata.concurrencySafe,
            interruptBehavior: metadata.interruptBehavior,
            paths: metadata.paths,
            activityDescription: metadata.activityDescription,
            toolUseSummary: metadata.toolUseSummary,
          });
          if (outcome.status === "background" && !safe) {
            detachedExclusiveTaskId = outcome.taskId;
          }
          return outcome;
        });

      settlements[index] = settlement;
      executing.push({ safe, promise: settlement });
      void settlement.finally(() => {
        const position = executing.findIndex(
          (entry) => entry.promise === settlement,
        );
        if (position >= 0) executing.splice(position, 1);
      });
    };

    const run = async (): Promise<void> => {
      for (let index = 0; index < toolCalls.length; index += 1) {
        const toolCall = toolCalls[index]!;
        if (deferAfterBackground(toolCall, index)) continue;
        const metadata = this.tools.describeCall(
          toolCall.name,
          toolCall.arguments,
        );
        const safe = metadata.concurrencySafe;
        const canStartAlongsideCurrent = safe && executing.every((entry) => entry.safe);
        if (!canStartAlongsideCurrent && executing.length > 0) {
          await Promise.all(executing.map((entry) => entry.promise));
        }
        if (deferAfterBackground(toolCall, index)) continue;
        emit({
          type: "tool_lifecycle",
          name: toolCall.name,
          argumentsText: toolCall.arguments,
          taskId: toolCall.id,
          toolCallId: toolCall.id,
          lifecycle: {
            taskId: toolCall.id,
            stage: "tool_queued",
            ok: true,
            detail: metadata.concurrencySafe
              ? "ready to run concurrently"
              : "waiting for exclusive execution",
          },
        });
        start(toolCall, index);
      }
      if (executing.length > 0) {
        await Promise.all(executing.map((entry) => entry.promise));
      }
    };

    void run().catch((error) => {
      runnerError = error;
      emit({
        type: "harness_error",
        name: "tool_executor",
        argumentsText: "",
        taskId: `executor-${randomUUID()}`,
        toolCallId: "",
        error: normalizeHarnessError(error, {
          code: "tool_batch_failure",
          layer: "tool",
          phase: "batch_scheduler",
          scope: "turn",
        }),
        decision: {
          action: "abort",
          reason: "tool batch scheduler failed",
        },
      });
    }).finally(() => {
      finished = true;
      const pending = wake;
      wake = undefined;
      pending?.();
    });

    while (!finished || events.length > 0) {
      while (events.length > 0) {
        yield events.shift()!;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }

    if (runnerError) throw runnerError;
    return await Promise.all(settlements);
  }

  private async executeCall(
    toolCall: ChatToolCall,
    metadata: ReturnType<ToolRegistry["describeCall"]>,
    foregroundContext: Parameters<ToolRegistry["execute"]>[2],
    emit: (event: StreamingToolEvent) => void,
  ): Promise<ToolExecutionOutcome> {
    const threshold = metadata.backgroundAfterMs;
    if (
      !this.taskManager ||
      !metadata.supportsBackground ||
      threshold === undefined
    ) {
      const dependencyFailure = await this.waitForArtifactDependencies(
        toolCall,
        metadata,
        foregroundContext?.signal,
        emit,
      );
      if (dependencyFailure) return dependencyFailure;
      return this.tools.execute(
        toolCall.name,
        toolCall.arguments,
        foregroundContext,
      );
    }

    const sandbox = this.tools.getSandboxPolicy();
    const deduplicationKey = createToolTaskKey(
      toolCall.name,
      toolCall.arguments,
      sandbox?.sandboxRoot,
    );
    const existing = this.taskManager.getActiveByDeduplicationKey<ToolExecutionOutcome>(
      deduplicationKey,
    );
    if (existing) {
      if (existing.metadata?.detached === true) {
        return createBackgroundOutcome(existing, true);
      }
      // The existing execution is still owned by another foreground call. Do
      // not describe it as a background task before that call has transferred
      // ownership. Sharing the terminal promise also avoids starting the tool
      // a second time.
      const settled = await this.taskManager.wait<ToolExecutionOutcome>(existing.id);
      return outcomeFromTask(settled);
    }

    if (toolCall.name === "run_qgis_algorithm" && foregroundContext?.sessionId) {
      const pendingQgis = this.taskManager.list({
        statuses: ["queued", "running", "cancelling"],
        name: "run_qgis_algorithm",
      }).find((task) => task.metadata?.detached === true &&
        task.metadata?.sessionId === foregroundContext?.sessionId);
      if (pendingQgis) {
        return createDeferredByBackgroundOutcome(toolCall, pendingQgis.id);
      }
    }

    const dependencyFailure = await this.waitForArtifactDependencies(
      toolCall,
      metadata,
      foregroundContext?.signal,
      emit,
    );
    if (dependencyFailure) return dependencyFailure;

    let attached = true;
    let removeForegroundAbort = (): void => {};
    let resolvePreflight: (() => void) | undefined;
    const preflightReady = new Promise<void>((resolve) => {
      resolvePreflight = resolve;
    });

    const task = this.taskManager.submit<ToolExecutionOutcome>({
      name: toolCall.name,
      description: metadata.activityDescription ?? `Running ${toolCall.name}`,
      deduplicationKey,
      resourceKeys: buildResourceKeys(metadata, sandbox),
      artifactPaths: resolveToolPaths(metadata.writePaths, sandbox, true),
      metadata: {
        kind: "tool_execution",
        detached: false,
        source: metadata.source,
        toolCallId: toolCall.id,
        runId: foregroundContext?.runId,
        sessionId: foregroundContext?.sessionId,
        transientRun: foregroundContext?.transientRun,
        projectDir: sandbox?.projectDir,
        workspaceDir: sandbox?.workspaceRoot,
        backgroundAfterMs: threshold,
      },
      runner: (taskContext) => this.runBackgroundTool(
        toolCall,
        taskContext,
        foregroundContext,
        (event) => {
          if (event.type === "tool_lifecycle" && event.lifecycle.stage === "tool_started") {
            resolvePreflight?.();
          }
          if (attached) emit(event);
        },
      ),
    });

    const foregroundSignal = foregroundContext?.signal;
    if (foregroundSignal) {
      const abortForegroundTask = (): void => {
        if (!attached) return;
        this.taskManager?.cancel(
          task.id,
          "foreground Agent run cancelled before background ownership transfer",
        );
      };
      foregroundSignal.addEventListener("abort", abortForegroundTask, { once: true });
      removeForegroundAbort = () =>
        foregroundSignal.removeEventListener("abort", abortForegroundTask);
      if (foregroundSignal.aborted) abortForegroundTask();
    }

    const terminal = this.taskManager.wait<ToolExecutionOutcome>(task.id).then(
      (snapshot) => ({ type: "terminal" as const, snapshot }),
    );
    const detach = Promise.all([
      delay(threshold),
      preflightReady,
    ]).then(() => {
      attached = false;
      removeForegroundAbort();
      this.taskManager?.updateMetadata(task.id, { detached: true });
      return { type: "background" as const };
    });
    const decision = await Promise.race([terminal, detach]);

    if (decision.type === "terminal") {
      attached = false;
      removeForegroundAbort();
      return outcomeFromTask(decision.snapshot);
    }

    // Permission, sandbox and artifact preflight have completed because the
    // registry emitted tool_started. Only the long-running handler is detached.
    attached = false;
    const latest = this.taskManager.get<ToolExecutionOutcome>(task.id) ?? task;
    return createBackgroundOutcome(latest, false);
  }

  private async waitForArtifactDependencies(
    toolCall: ChatToolCall,
    metadata: ReturnType<ToolRegistry["describeCall"]>,
    signal: AbortSignal | undefined,
    emit: (event: StreamingToolEvent) => void,
  ): Promise<ToolExecutionOutcome | undefined> {
    if (!this.taskManager) return undefined;
    const sandbox = this.tools.getSandboxPolicy();
    const paths = new Set([
      ...resolveToolPaths(metadata.readPaths, sandbox, false),
      ...resolveToolPaths(metadata.writePaths, sandbox, true),
    ].map(normalizeDependencyPath));
    if (paths.size === 0) return undefined;
    const dependencies = this.taskManager.list({
      statuses: ["queued", "running", "cancelling"],
    }).filter((task) => task.metadata?.kind === "tool_execution" &&
      task.artifactPaths.some((path) =>
        paths.has(normalizeDependencyPath(path))
      ));
    if (dependencies.length === 0) return undefined;

    emit({
      type: "tool_lifecycle",
      name: toolCall.name,
      argumentsText: toolCall.arguments,
      taskId: toolCall.id,
      toolCallId: toolCall.id,
      lifecycle: {
        taskId: toolCall.id,
        stage: "tool_queued",
        ok: true,
        detail: `waiting for ${dependencies.length} upstream artifact task(s)`,
      },
    });
    const settled = await Promise.all(dependencies.map((task) =>
      this.taskManager!.wait(task.id, { signal })
    ));
    const failed = settled.find((task) =>
      task.status !== "completed" ||
      (isStoredToolOutcome(task.result) && !task.result.ok)
    );
    if (!failed) return undefined;
    return {
      ok: false,
      status: "failed",
      taskId: `dependency-${toolCall.id}`,
      content: `Tool ${toolCall.name} was not started because upstream task ${failed.id} ${failed.status}. Review its completion result before planning the next processing step.`,
    };
  }

  private async runBackgroundTool(
    toolCall: ChatToolCall,
    taskContext: TaskExecutionContext,
    foregroundContext: Parameters<ToolRegistry["execute"]>[2],
    emit: (event: StreamingToolEvent) => void,
  ): Promise<ToolExecutionOutcome> {
    const context = {
      ...foregroundContext,
      taskId: taskContext.taskId,
      signal: taskContext.signal,
      emitProgress: (progress: ToolProgress) => {
        taskContext.reportProgress(progress);
        emit({
          type: "tool_progress",
          name: toolCall.name,
          argumentsText: toolCall.arguments,
          taskId: progress.taskId ?? taskContext.taskId,
          toolCallId: toolCall.id,
          progress,
        });
      },
      emitLifecycle: (lifecycle: ToolLifecycleEvent) => emit({
        type: "tool_lifecycle",
        name: toolCall.name,
        argumentsText: toolCall.arguments,
        taskId: lifecycle.taskId ?? taskContext.taskId,
        toolCallId: toolCall.id,
        lifecycle,
      }),
    };
    const outcome = await this.tools.execute(
      toolCall.name,
      toolCall.arguments,
      context,
    );
    if (!outcome.ok) throw new BackgroundToolExecutionError(outcome);
    return outcome;
  }
}

function createToolTaskKey(
  name: string,
  argumentsText: string,
  executionScope?: string,
): string {
  let normalizedArguments = argumentsText.trim();
  try {
    normalizedArguments = stableJson(JSON.parse(argumentsText));
  } catch {
    // Invalid JSON is still stable enough for deduplication by raw text. The
    // registry will report the actual validation error.
  }
  return createHash("sha256")
    .update(`${executionScope ?? "global"}\n${name}\n${normalizedArguments}`)
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function buildResourceKeys(
  metadata: ReturnType<ToolRegistry["describeCall"]>,
  sandbox: ReturnType<ToolRegistry["getSandboxPolicy"]>,
): string[] {
  const keys = (metadata.writePaths ?? []).map((path) => {
    let resolved = path;
    try {
      resolved = sandbox?.resolveWritePath(path) ?? path;
    } catch {
      // The registry preflight will report the authoritative sandbox error.
    }
    return `path:${resolved.replace(/[\\/]+/gu, "\\").toLowerCase()}`;
  });
  if (!metadata.concurrencySafe) keys.push("exclusive:background-tool");
  return keys;
}

function resolveToolPaths(
  paths: readonly string[] | undefined,
  sandbox: ReturnType<ToolRegistry["getSandboxPolicy"]>,
  write: boolean,
): string[] {
  return (paths ?? []).map((path) => {
    try {
      return write
        ? sandbox?.resolveWritePath(path) ?? resolve(path)
        : sandbox?.resolveReadPath(path) ?? resolve(path);
    } catch {
      // The registry remains responsible for reporting invalid paths.
      return resolve(path);
    }
  });
}

function normalizeDependencyPath(path: string): string {
  const absolute = resolve(path).replace(/[\\/]+/gu, "\\");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isStoredToolOutcome(value: unknown): value is ToolExecutionOutcome {
  return typeof value === "object" && value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean";
}

function createBackgroundOutcome(
  task: TaskSnapshot<ToolExecutionOutcome>,
  reused: boolean,
): ToolExecutionOutcome {
  const artifacts = task.artifactPaths.length > 0
    ? `\nPending artifacts (do not use until the task completes):\n- ${task.artifactPaths.join("\n- ")}`
    : "";
  return {
    ok: true,
    status: "background",
    taskId: task.id,
    content: [
      reused
        ? "An identical tool call is already running in the background."
        : "The tool exceeded its foreground wait threshold and continues in the background.",
      `Task ID: ${task.id}`,
      `Task status: ${task.status}`,
      "The final result is NOT available yet.",
      "This is pending, not a successful processing result. Do not start a substitute QGIS algorithm for this step.",
      "Do not poll this task. Its terminal result will be delivered automatically as a task notification.",
      artifacts,
    ].filter(Boolean).join("\n"),
  };
}

function outcomeFromTask(
  task: TaskSnapshot<ToolExecutionOutcome>,
): ToolExecutionOutcome {
  if (task.status === "completed" && task.result) return task.result;
  const storedOutcome = getStoredToolOutcome(task);
  if (storedOutcome) return storedOutcome;
  return {
    ok: false,
    status: "failed",
    taskId: task.id,
    content: `Tool task ${task.id} ${task.status}: ${task.error?.message ?? task.cancellationReason ?? "no result"}`,
  };
}

function getStoredToolOutcome(
  task: TaskSnapshot<ToolExecutionOutcome>,
): ToolExecutionOutcome | undefined {
  const value = task.error?.details?.toolOutcome;
  return isToolExecutionOutcome(value) ? value : undefined;
}

function isToolExecutionOutcome(value: unknown): value is ToolExecutionOutcome {
  return typeof value === "object" && value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean" &&
    typeof (value as { content?: unknown }).content === "string" &&
    typeof (value as { taskId?: unknown }).taskId === "string";
}

class BackgroundToolExecutionError extends Error {
  readonly code = "background_tool_failed";
  readonly details: Record<string, unknown>;

  constructor(outcome: ToolExecutionOutcome) {
    super(outcome.content);
    this.name = "BackgroundToolExecutionError";
    this.details = { toolOutcome: outcome };
  }
}

function createDeferredByBackgroundOutcome(
  toolCall: ChatToolCall,
  backgroundTaskId: string,
): ToolExecutionOutcome {
  return {
    ok: false,
    status: "failed",
    taskId: `deferred-${toolCall.id}`,
    content: [
      `Tool ${toolCall.name} was not started because exclusive task ${backgroundTaskId} is still running in the background.`,
      `Its final result will be delivered automatically. Reassess the processing plan after that notification; do not retry or substitute another algorithm meanwhile.`,
    ].join("\n"),
  };
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
