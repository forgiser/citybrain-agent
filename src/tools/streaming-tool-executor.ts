import { randomUUID } from "node:crypto";
import type { AgentStatusUpdate } from "../agent/agent-status.js";
import type { ChatToolCall } from "../models/model-chat.js";
import {
  ToolRegistry,
  type ToolExecutionOutcome,
  type ToolLifecycleEvent,
  type ToolProgress,
} from "./tool-registry.js";
import type { ToolInterruptBehavior, ToolSource } from "./tool-contract.js";
import {
  normalizeHarnessError,
  type HarnessError,
  type HarnessRecoveryDecision,
} from "../harness/index.js";

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
  | ({ type: "agent_status" } & AgentStatusUpdate);

export interface StreamingToolExecutorOptions {
  runId: string;
  turn: number;
  signal?: AbortSignal;
}

/**
 * Owns the tool lifecycle for one assistant tool-call batch.
 *
 * The model loop only consumes lifecycle events and the final outcomes. It
 * does not need to know how concurrency-safe and exclusive tools are queued.
 */
export class StreamingToolExecutor {
  constructor(private readonly tools: ToolRegistry) {}

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

    const emit = (event: StreamingToolEvent): void => {
      events.push(event);
      const pending = wake;
      wake = undefined;
      pending?.();
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
        turn: options.turn,
        toolCallId: toolCall.id,
        signal: metadata.interruptBehavior === "cancel" ? options.signal : undefined,
        queued: true,
        emitAgentStatus: (update: AgentStatusUpdate) =>
          emit({ type: "agent_status", ...update }),
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

      const settlement = this.tools
        .execute(toolCall.name, toolCall.arguments, context)
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
            source: metadata.source,
            readOnly: metadata.readOnly,
            destructive: metadata.destructive,
            concurrencySafe: metadata.concurrencySafe,
            interruptBehavior: metadata.interruptBehavior,
            paths: metadata.paths,
            activityDescription: metadata.activityDescription,
            toolUseSummary: metadata.toolUseSummary,
          });
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
        const metadata = this.tools.describeCall(
          toolCall.name,
          toolCall.arguments,
        );
        const safe = metadata.concurrencySafe;
        const canStartAlongsideCurrent = safe && executing.every((entry) => entry.safe);
        if (!canStartAlongsideCurrent && executing.length > 0) {
          await Promise.all(executing.map((entry) => entry.promise));
        }
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
}
