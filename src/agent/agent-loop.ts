import type { AuthStorage } from "../auth/auth-storage.js";
import { randomUUID } from "node:crypto";
import type { ModelDefinition } from "../models/model-catalog.js";
import {
  streamModelChat,
  type ChatMessage,
  type ChatToolCall,
  type ModelUsage,
  type StreamChatOptions,
} from "../models/model-chat.js";
import { buildSystemPromptForCwd } from "../context/index.js";
import { ModelRuntime } from "../models/model-runtime.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  SessionManager,
} from "../session/session-manager.js";
import {
  createEstimatedUsageSnapshot,
  createHybridUsageSnapshot,
  createProviderUsageSnapshot,
  estimateChatContextTokens,
  getContextTokensFromUsage,
  type ContextUsageSnapshot,
} from "../context/context-usage.js";
import { ContextUsageLogger } from "../context/context-usage-log.js";
import { ContextTraceLogger } from "../context/context-trace-log.js";
import type {
  AgentHarnessState,
  AgentHarnessStateUpdate,
} from "./agent-state.js";
import { ToolExecutionLogger } from "../tools/tool-execution-log.js";
import type {
  ToolCallContext,
  ToolExecutionOutcome,
  ToolProgress,
  ToolRegistry,
} from "../tools/tool-registry.js";
export type { ToolProgress } from "../tools/tool-registry.js";

export interface ToolExecutionStarted {
  name: string;
  argumentsText: string;
  taskId?: string;
}

export interface ToolExecutionResult extends ToolExecutionStarted {
  ok: boolean;
  result: string;
}

const MAX_TOOL_TURNS = 12;
const MAX_IDENTICAL_TOOL_BATCHES = 3;
const FINALIZATION_INSTRUCTION =
  "The execution harness is entering finalization. Do not call any tools. " +
  "Use the completed tool results already in the conversation to provide the best " +
  "possible answer. Clearly state what was completed, what was not completed, and " +
  "the next action if the user's request remains unfinished.";

/**
 * Structured events yielded by AgentLoop.run(). The consumer (UI) pulls them
 * with `for await` and renders incrementally - no callbacks, no folding.
 */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | ({ type: "tool_started" } & ToolExecutionStarted)
  | ({ type: "tool_result" } & ToolExecutionResult)
  | {
      type: "tool_progress";
      name: string;
      argumentsText: string;
      taskId: string;
      progress: ToolProgress;
    }
  | ({ type: "state" } & AgentHarnessStateUpdate)
  | { type: "context"; snapshot: ContextUsageSnapshot }
  | ({ type: "agent_status" } & AgentStatusUpdate);

import type { AgentStatusUpdate } from "./agent-status.js";
export type { AgentStatus, AgentStatusUpdate } from "./agent-status.js";

export class AgentLoop {
  constructor(
    private readonly modelRuntime: ModelRuntime,
    private readonly authStorage: AuthStorage,
    private session: SessionManager,
    private readonly tools: ToolRegistry,
    private readonly logger?: ToolExecutionLogger,
    private readonly contextLogger?: ContextUsageLogger,
    private readonly contextTraceLogger?: ContextTraceLogger,
  ) {}

  getSelectedModel(): ModelDefinition | undefined {
    return this.modelRuntime.getSelectedModel();
  }

  async *run(
    input: string,
    options: StreamChatOptions = {},
  ): AsyncGenerator<AgentEvent, string, undefined> {
    const runId = randomUUID();
    let state: AgentHarnessState = "idle";
    let turn = 0;
    let toolTurnCount = 0;
    let finalizationRequested = false;
    let finalizationReason = "";
    let lastToolBatchSignature = "";
    let identicalToolBatchCount = 0;
    let requestIndex = 0;
    let measuredMessageCount: number | undefined;
    const toolHistory: Array<{ name: string; ok: boolean }> = [];

    const transition = (
      next: AgentHarnessState,
      reason?: string,
    ): AgentEvent => {
      const update: AgentHarnessStateUpdate = {
        runId,
        turn,
        state: next,
        previousState: state,
        ...(reason ? { reason } : {}),
      };
      state = next;
      void this.logger?.recordHarnessState(
        runId,
        turn,
        next,
        update.previousState,
        reason,
      );
      return { type: "state", ...update };
    };

    const publishContext = (snapshot: ContextUsageSnapshot): AgentEvent => {
      void this.contextLogger?.record(snapshot);
      return { type: "context", snapshot };
    };

    try {
      const model =
        this.modelRuntime.getSelectedModel() ??
        this.modelRuntime.ensureSelection();
      if (!model) {
        throw new Error(
          "No active model. Run /login and select a model first.",
        );
      }

      const credential = this.authStorage.get(model.provider);
      if (!credential) {
        throw new Error("Provider is not logged in: " + model.provider);
      }

      const systemPrompt = await buildSystemPromptForCwd(this.session.getCwd());
      let messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...this.session.getContextMessages(),
      ];
      const userMessage = {
        role: "user",
        content: input,
      } as const;
      messages.push(userMessage);
      this.session.appendMessage(userMessage);

      let finalResponse = "";
      let finalThinking = "";
      let latestUsage: ModelUsage | undefined;
      const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const contextWindowSource = model.contextWindow
        ? "model_metadata"
        : "fallback";

      while (true) {
        if (finalizationRequested) {
          yield transition("finalizing", finalizationReason);
        }
        yield transition(
          "streaming_model",
          finalizationRequested
            ? "requesting final answer without tools"
            : undefined,
        );

        let response = "";
        let thinking = "";
        const toolCalls = new Map<number, ChatToolCall>();
        const availableTools = finalizationRequested
          ? []
          : this.tools.definitions();
        const currentRequestIndex = requestIndex++;
        const contextBase = {
          runId,
          turn,
          requestIndex: currentRequestIndex,
          provider: model.provider,
          model: model.id,
          contextWindow,
          contextWindowSource,
        } as const;
        const compaction = this.session.compactContext(
          contextWindow,
          systemPrompt,
          availableTools,
          finalizationRequested ? "before_finalization" : "context_threshold",
        );
        if (compaction) {
          latestUsage = undefined;
          measuredMessageCount = undefined;
          messages = [
            { role: "system", content: systemPrompt },
            ...this.session.getContextMessages(),
          ];
          const compactedSnapshot = createEstimatedUsageSnapshot(
            {
              ...contextBase,
              stage: "before_request",
            },
            estimateChatContextTokens(messages, availableTools),
          );
          void this.contextTraceLogger?.recordCompaction(
            compactedSnapshot,
            finalizationRequested ? "before_finalization" : "context_threshold",
            compaction,
          );
          yield publishContext(compactedSnapshot);
        }
        const beforeRequestSnapshot =
          latestUsage && measuredMessageCount !== undefined
            ? createHybridUsageSnapshot(
                {
                  ...contextBase,
                  stage: "before_request",
                },
                latestUsage,
                estimateChatContextTokens(
                  messages.slice(measuredMessageCount),
                  [],
                ),
              )
            : createEstimatedUsageSnapshot(
                {
                  ...contextBase,
                  stage: "before_request",
                },
                estimateChatContextTokens(messages, availableTools),
              );
        yield publishContext(beforeRequestSnapshot);
        void this.contextTraceLogger?.recordRequest(
          beforeRequestSnapshot,
          messages,
          availableTools,
        );
        let usageForCall: ModelUsage | undefined;

        for await (const delta of streamModelChat(model, credential, messages, {
          ...options,
          tools: availableTools,
          onUsage: (nextUsage) => {
            usageForCall = nextUsage;
            latestUsage = nextUsage;
            options.onUsage?.(nextUsage);
          },
        })) {
          if (delta.type === "thinking") {
            thinking += delta.delta;
            yield { type: "thinking", delta: delta.delta };
            continue;
          }
          if (delta.type === "text") {
            response += delta.delta;
            yield { type: "text", delta: delta.delta };
            continue;
          }

          const toolCall = delta.toolCall;
          if (!toolCall) continue;
          const existing = toolCalls.get(toolCall.index) ?? {
            id: toolCall.id ?? "tool-call-" + turn + "-" + toolCall.index,
            name: toolCall.name ?? "",
            arguments: "",
          };
          if (toolCall.id) existing.id = toolCall.id;
          if (toolCall.name) existing.name = toolCall.name;
          existing.arguments += delta.delta;
          toolCalls.set(toolCall.index, existing);
        }

        if (usageForCall && getContextTokensFromUsage(usageForCall) > 0) {
          const responseSnapshot = createProviderUsageSnapshot(
            {
              ...contextBase,
              stage: "after_response",
            },
            usageForCall,
          );
          yield publishContext(responseSnapshot);
          void this.contextTraceLogger?.recordResponse(
            responseSnapshot,
            messages,
          );
          measuredMessageCount = messages.length;
        } else {
          const responseSnapshot = createEstimatedUsageSnapshot(
            {
              ...contextBase,
              stage: "after_response",
            },
            estimateChatContextTokens(messages, availableTools),
          );
          yield publishContext(responseSnapshot);
          void this.contextTraceLogger?.recordResponse(
            responseSnapshot,
            messages,
          );
          measuredMessageCount = undefined;
        }

        finalThinking += thinking;

        if (toolCalls.size === 0) {
          if (response.trim()) {
            finalResponse = response;
          } else if (!finalizationRequested) {
            finalizationRequested = true;
            finalizationReason = "model returned no final text";
            messages.push({ role: "user", content: FINALIZATION_INSTRUCTION });
            turn += 1;
            continue;
          } else {
            finalResponse = buildFallbackResponse(
              toolHistory,
              finalizationReason,
            );
          }
          yield transition("completed", "final answer received");
          break;
        }

        if (finalizationRequested) {
          finalResponse = buildFallbackResponse(
            toolHistory,
            "model attempted another tool call during finalization",
          );
          yield transition("completed", "finalization fallback used");
          break;
        }

        finalizationReason = "";
        const resolvedToolCalls = [...toolCalls.values()];
        messages.push({
          role: "assistant",
          content: response,
          toolCalls: resolvedToolCalls,
        });
        this.session.appendMessage({
          role: "assistant",
          content: response,
          toolCalls: resolvedToolCalls,
          provider: model.provider,
          model: model.id,
        });

        const batchSignature = JSON.stringify(
          resolvedToolCalls.map((toolCall) => [
            toolCall.name,
            toolCall.arguments,
          ]),
        );
        if (batchSignature === lastToolBatchSignature) {
          identicalToolBatchCount += 1;
        } else {
          lastToolBatchSignature = batchSignature;
          identicalToolBatchCount = 1;
        }

        yield transition(
          "waiting_for_tools",
          `${resolvedToolCalls.length} tool call(s) received`,
        );
        yield transition("executing_tools");
        const outcomes = yield* this.executeToolTurn(
          resolvedToolCalls,
          runId,
          turn,
        );
        for (let index = 0; index < resolvedToolCalls.length; index++) {
          const outcome = outcomes[index]!;
          const toolCall = resolvedToolCalls[index]!;
          toolHistory.push({ name: toolCall.name, ok: outcome.ok });
          messages.push({
            role: "tool",
            content: outcome.content,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          this.session.appendMessage({
            role: "tool",
            content: outcome.content,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
        }

        toolTurnCount += 1;
        turn += 1;
        if (toolTurnCount >= MAX_TOOL_TURNS) {
          finalizationRequested = true;
          finalizationReason = `tool safety limit reached (${MAX_TOOL_TURNS} turns)`;
          messages.push({ role: "user", content: FINALIZATION_INSTRUCTION });
        } else if (identicalToolBatchCount >= MAX_IDENTICAL_TOOL_BATCHES) {
          finalizationRequested = true;
          finalizationReason = "the same tool batch repeated without progress";
          messages.push({ role: "user", content: FINALIZATION_INSTRUCTION });
        }
      }

      this.session.appendMessage({
        provider: model.provider,
        model: model.id,
        role: "assistant",
        content: finalResponse,
        thinking: finalThinking || undefined,
        usage: latestUsage,
      });
      return finalResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedState = message.toLowerCase().includes("abort")
        ? "aborted"
        : "failed";
      yield transition(failedState, message);
      throw error;
    }
  }

  /**
   * Bridge the concurrent tool scheduler into the event stream. Tools emit
   * events into a queue as they start/complete; this generator drains the
   * queue and yields until every call has settled, then returns the outcomes
   * in the original call order.
   */
  private async *executeToolTurn(
    resolvedToolCalls: ChatToolCall[],
    runId: string,
    turn: number,
  ): AsyncGenerator<AgentEvent, ToolExecutionOutcome[], undefined> {
    const events: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const emit = (event: AgentEvent): void => {
      events.push(event);
      const pending = wake;
      wake = undefined;
      pending?.();
    };

    const runner = this.startToolCalls(
      resolvedToolCalls,
      emit,
      runId,
      turn,
    ).then(
      (outcomes) => {
        finished = true;
        return outcomes;
      },
      (error) => {
        finished = true;
        throw error;
      },
    );

    while (true) {
      while (events.length > 0) {
        yield events.shift()!;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }

    return await runner;
  }

  /**
   * Start every tool call of one assistant turn according to the concurrency
   * rules and return the outcomes in the original call order.
   *
   * Mirrors Claude Code's StreamingToolExecutor queue scan: walk the calls in
   * order; a concurrency-safe tool starts immediately (all executing tools are
   * safe by construction here), a non-safe tool waits for everything in flight
   * and then runs exclusively - later calls queue behind it.
   */
  private async startToolCalls(
    resolvedToolCalls: ChatToolCall[],
    emit: (event: AgentEvent) => void,
    runId: string,
    turn: number,
  ): Promise<ToolExecutionOutcome[]> {
    const settlements: Promise<ToolExecutionOutcome>[] = new Array(
      resolvedToolCalls.length,
    );
    let executing = new Set<Promise<unknown>>();

    const start = (toolCall: ChatToolCall, index: number): void => {
      emit({
        type: "tool_started",
        name: toolCall.name,
        argumentsText: toolCall.arguments,
      });
      // Let a tool (e.g. delegate) stream subagent status updates up as
      // agent_status events in the same queue as tool_started/tool_result.
      const context: ToolCallContext = {
        emitAgentStatus: (update) => emit({ type: "agent_status", ...update }),
        runId,
        turn,
        toolCallId: toolCall.id,
        emitProgress: (progress) => {
          emit({
            type: "tool_progress",
            name: toolCall.name,
            argumentsText: toolCall.arguments,
            taskId: progress.taskId ?? toolCall.id,
            progress,
          });
        },
      };
      const settlement = this.tools
        .execute(toolCall.name, toolCall.arguments, context)
        .then((outcome) => {
          emit({
            type: "tool_result",
            name: toolCall.name,
            argumentsText: toolCall.arguments,
            taskId: outcome.taskId,
            ok: outcome.ok,
            result: outcome.content,
          });
          return outcome;
        });
      settlements[index] = settlement;
      executing.add(settlement);
      void settlement
        .catch(() => undefined)
        .finally(() => executing.delete(settlement));
    };

    for (let index = 0; index < resolvedToolCalls.length; index++) {
      const toolCall = resolvedToolCalls[index]!;
      if (this.tools.isConcurrencySafe(toolCall.name, toolCall.arguments)) {
        start(toolCall, index);
        continue;
      }
      await Promise.all(executing);
      executing = new Set();
      start(toolCall, index);
    }

    return Promise.all(settlements);
  }

  setSession(session: SessionManager): void {
    this.session = session;
  }
}

function buildFallbackResponse(
  history: Array<{ name: string; ok: boolean }>,
  reason: string,
): string {
  const summary =
    history.length === 0
      ? "No tool result was available."
      : history
          .slice(-8)
          .map(
            (item, index) =>
              `${index + 1}. ${item.name} (${item.ok ? "succeeded" : "failed"})`,
          )
          .join("\n");

  return [
    "The harness reached a safe execution boundary before a normal final response was produced.",
    reason ? `Reason: ${reason}.` : "",
    "Tool activity:",
    summary,
    "Review the tool execution log for full arguments and results.",
  ]
    .filter(Boolean)
    .join("\n");
}
