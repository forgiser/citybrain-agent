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
import {
  buildSystemPromptForCwd,
  compressContextMessages,
  restoreContextProjectionState,
  projectContextMessages,
  readAnalysisTask,
  type ContextBuildInputs,
  type PersistedToolResultProjection,
} from "../context/index.js";
import { ModelRuntime } from "../models/model-runtime.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  SessionManager,
} from "../session/session-manager.js";
import {
  createEstimatedUsageSnapshot,
  createProviderUsageSnapshot,
  estimateChatContextTokens,
  getPromptTokensFromUsage,
  type ContextUsageSnapshot,
} from "../context/context-usage.js";
import { ContextUsageLogger } from "../context/context-usage-log.js";
import { ContextTraceLogger } from "../context/context-trace-log.js";
import type {
  AgentHarnessState,
  AgentHarnessStateUpdate,
} from "./agent-state.js";
import { ToolExecutionLogger } from "../tools/core/observability/tool-execution-log.js";
import type {
  ToolExecutionOutcome,
  ToolProgress,
  ToolRegistry,
} from "../tools/core/execution/tool-registry.js";
import {
  StreamingToolExecutor,
  type StreamingToolEvent,
  type ToolExecutionResult,
  type ToolExecutionStarted,
} from "../tools/core/execution/streaming-tool-executor.js";
import { HarnessController } from "../harness/index.js";
import type { HumanInteractionBroker } from "../harness/human-interaction.js";
import type { TaskManager } from "../task/index.js";
export type { ToolProgress } from "../tools/core/contracts/tool-types.js";
export type {
  ToolExecutionResult,
  ToolExecutionStarted,
} from "../tools/core/execution/streaming-tool-executor.js";

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
  | StreamingToolEvent
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
    private readonly getContextInputs?: () => ContextBuildInputs,
    private readonly humanInteractionBroker?: HumanInteractionBroker,
    taskManager?: TaskManager,
  ) {
    this.streamingToolExecutor = new StreamingToolExecutor(tools, taskManager);
  }

  private readonly streamingToolExecutor: StreamingToolExecutor;

  getSelectedModel(): ModelDefinition | undefined {
    return this.modelRuntime.getSelectedModel();
  }

  async *run(
    input: string,
    options: StreamChatOptions = {},
  ): AsyncGenerator<AgentEvent, string, undefined> {
    const runId = randomUUID();
    const harness = new HarnessController({
      runId,
      humanInteractionBroker: this.humanInteractionBroker,
      onEvent: (event) => {
        if (event.type === "state") {
          void this.logger?.recordHarnessState(
            event.runId,
            event.turn,
            event.state,
            event.previousState,
            event.reason,
          );
          return;
        }
        if (event.type === "error") {
          void this.logger?.record(
            ToolExecutionLogger.createHarnessErrorEvent(
              `harness-${runId}`,
              "harness",
              event.error,
              { runId, turn: event.turn },
            ),
          );
          return;
        }
        void this.logger?.record(
          ToolExecutionLogger.createLifecycleEvent(
            `harness-${runId}`,
            "harness",
            "recovery_decision",
            { runId, turn: event.turn },
            true,
            event.decision.reason,
          ),
        );
      },
    });
    const unsubscribeHuman = this.humanInteractionBroker?.subscribe((event) => {
      if (event.request.runId !== runId) return;
      harness.setTurn(turn);
      if (event.type === "created") {
        if (harness.canTransition("waiting_for_human")) {
          harness.transition("waiting_for_human", event.request.message);
        }
        return;
      }
      if (harness.canTransition("resuming")) {
        harness.transition("resuming", `human decision: ${event.decision.action}`);
      }
      if (harness.canTransition("executing")) {
        harness.transition("executing", "resuming after human decision");
      }
    });
    let state: AgentHarnessState = "idle";
    let turn = 0;
    let toolTurnCount = 0;
    let finalizationRequested = false;
    let finalizationReason = "";
    let lastToolBatchSignature = "";
    let identicalToolBatchCount = 0;
    let requestIndex = 0;
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

    const syncHarnessState = (
      next:
        | "planning"
        | "executing"
        | "finalizing"
        | "completed"
        | "failed"
        | "aborted",
      reason?: string,
    ): void => {
      harness.setTurn(turn);
      if (harness.state === next || !harness.canTransition(next)) return;
      harness.transition(next, reason);
    };

    const publishContext = (snapshot: ContextUsageSnapshot): AgentEvent => {
      void this.contextLogger?.record(snapshot);
      return { type: "context", snapshot };
    };

    try {
      syncHarnessState("planning", "run started");
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

      const projectionState = restoreContextProjectionState(
        this.session.getContextReplacementRecords(),
      );
      // Keep the canonical conversation separate from the system prompt.
      // The provider receives a combined request snapshot, but the agent
      // state never treats system instructions as ordinary conversation.
      let conversationMessages: ChatMessage[] = [
        ...this.session.getContextMessages(),
      ];
      const userMessage = {
        role: "user",
        content: input,
      } as const;
      conversationMessages.push(userMessage);
      this.session.appendMessage(userMessage);

      let finalResponse = "";
      let finalThinking = "";
      let latestUsage: ModelUsage | undefined;
      const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const contextWindowSource = model.contextWindow
        ? "model_metadata"
        : "fallback";

      while (true) {
        const contextInputs = this.getContextInputs?.() ?? {};
        const systemPrompt = await buildSystemPromptForCwd(
          this.session.getProjectDir(),
          {
            ...contextInputs,
            analysisTask:
              contextInputs.analysisTask ??
              readAnalysisTask(this.session.getWorkspaceDir()),
          },
        );
        let projection = await projectContextMessages(
          conversationMessages,
          this.session.getWorkspaceDir(),
          undefined,
          projectionState,
        );
        appendProjectionReplacements(this.session, projection.newReplacements);
        const availableTools = finalizationRequested
          ? []
          : this.tools.definitions();
        const compression = await compressContextMessages(
          projection.messages,
          {
            contextWindow,
            fixedTokens: estimateFixedContextTokens(systemPrompt, availableTools),
            generateSummary: (messages) =>
              this.generateContextSummary(model, credential, messages, options),
          },
        );
        let requestMessages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          ...compression.messages,
        ];

        if (finalizationRequested) {
          syncHarnessState("finalizing", finalizationReason);
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
        // The previous provider usage belongs to the previous request. Since
        // the volatile system prompt may have changed, estimate this complete
        // request instead of blindly adding a trailing-message delta.
        const beforeRequestSnapshot = createEstimatedUsageSnapshot(
          {
            ...contextBase,
            stage: "before_request",
          },
          estimateChatContextTokens(requestMessages, availableTools),
        );
        yield publishContext(beforeRequestSnapshot);
        void this.contextTraceLogger?.recordRequest(
          beforeRequestSnapshot,
          requestMessages,
          availableTools,
          projection.report,
          compression.report,
        );
        let usageForCall: ModelUsage | undefined;

        for await (const delta of streamModelChat(model, credential, requestMessages, {
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

        if (usageForCall && getPromptTokensFromUsage(usageForCall) > 0) {
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
            requestMessages,
          );
        } else {
          const responseSnapshot = createEstimatedUsageSnapshot(
            {
              ...contextBase,
              stage: "after_response",
            },
            estimateChatContextTokens(requestMessages, availableTools),
          );
          yield publishContext(responseSnapshot);
          void this.contextTraceLogger?.recordResponse(
            responseSnapshot,
            requestMessages,
          );
        }

        finalThinking += thinking;

        if (toolCalls.size === 0) {
          if (response.trim()) {
            finalResponse = response;
          } else if (!finalizationRequested) {
            finalizationRequested = true;
            finalizationReason = "model returned no final text";
            conversationMessages.push({
              role: "user",
              content: FINALIZATION_INSTRUCTION,
            });
            turn += 1;
            continue;
          } else {
            finalResponse = buildFallbackResponse(
              toolHistory,
              finalizationReason,
            );
          }
          syncHarnessState("completed", "final answer received");
          yield transition("completed", "final answer received");
          break;
        }

        if (finalizationRequested) {
          finalResponse = buildFallbackResponse(
            toolHistory,
            "model attempted another tool call during finalization",
          );
          syncHarnessState("completed", "finalization fallback used");
          yield transition("completed", "finalization fallback used");
          break;
        }

        finalizationReason = "";
        const resolvedToolCalls = [...toolCalls.values()];
        conversationMessages.push({
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
        syncHarnessState("executing", "tool batch received");
        yield transition("executing_tools");
        const outcomes = yield* this.executeToolTurn(
          resolvedToolCalls,
          runId,
          turn,
          options.signal,
        );
        for (let index = 0; index < resolvedToolCalls.length; index++) {
          const outcome = outcomes[index]!;
          const toolCall = resolvedToolCalls[index]!;
          toolHistory.push({ name: toolCall.name, ok: outcome.ok });
          conversationMessages.push({
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
          if (outcome.preventContinuation) {
            finalizationRequested = true;
            finalizationReason =
              "a tool hook requested finalization after tool execution";
          }
        }

        toolTurnCount += 1;
        turn += 1;
        if (toolTurnCount >= MAX_TOOL_TURNS) {
          finalizationRequested = true;
          finalizationReason = `tool safety limit reached (${MAX_TOOL_TURNS} turns)`;
          conversationMessages.push({
            role: "user",
            content: FINALIZATION_INSTRUCTION,
          });
        } else if (identicalToolBatchCount >= MAX_IDENTICAL_TOOL_BATCHES) {
          finalizationRequested = true;
          finalizationReason = "the same tool batch repeated without progress";
          conversationMessages.push({
            role: "user",
            content: FINALIZATION_INSTRUCTION,
          });
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
      syncHarnessState("completed", "final answer persisted");
      return finalResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedState: "aborted" | "failed" = message.toLowerCase().includes("abort")
        ? "aborted"
        : "failed";
      const reported = harness.report(error, {
        layer: "agent_loop",
        phase: "run",
        scope: "run",
        details: { state, turn },
      });
      syncHarnessState(failedState, reported.decision.reason);
      yield {
        type: "harness_error",
        name: "harness",
        argumentsText: "",
        taskId: `harness-${runId}`,
        toolCallId: "",
        error: reported.error,
        decision: reported.decision,
      };
      yield transition(failedState, message);
      throw error;
    } finally {
      unsubscribeHuman?.();
    }
  }

  private async *executeToolTurn(
    resolvedToolCalls: ChatToolCall[],
    runId: string,
    turn: number,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, ToolExecutionOutcome[], undefined> {
    return yield* this.streamingToolExecutor.execute(
      resolvedToolCalls,
      { runId, turn, signal },
    );
  }

  private async generateContextSummary(
    model: ModelDefinition,
    credential: NonNullable<ReturnType<AuthStorage["get"]>>,
    messages: readonly ChatMessage[],
    options: StreamChatOptions,
  ): Promise<string | undefined> {
    const summaryInput = messages.map((message, index) => {
      const label = message.role === "tool"
        ? `tool:${message.toolName ?? "unknown"}`
        : message.role;
      const calls = message.toolCalls?.length
        ? `\nTool calls: ${message.toolCalls.map((call) =>
          `${call.name}(${call.arguments})`).join(", ")}`
        : "";
      return `### ${index + 1}. ${label}${calls}\n${message.content}`;
    }).join("\n\n");
    const summaryMessages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You are the context compression component of a geospatial analysis agent.",
          "Summarize the earlier conversation for another model that must continue the task.",
          "Preserve user goals, confirmed facts, paths, parameters, tool outcomes, failures,",
          "QGIS artifacts, pending work, and decisions. Remove repetition and speculation.",
          "Return only a concise structured summary. Do not call tools.",
        ].join(" "),
      },
      {
        role: "user",
        content: summaryInput,
      },
    ];
    let summary = "";
    try {
      for await (const delta of streamModelChat(model, credential, summaryMessages, {
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        maxTokens: 4_096,
        thinkingLevel: "off",
        tools: [],
      })) {
        if (delta.type === "text") summary += delta.delta;
      }
    } catch (error) {
      throw error;
    }
    return summary.trim() || undefined;
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

function appendProjectionReplacements(
  session: SessionManager,
  records: readonly PersistedToolResultProjection[],
): void {
  for (const record of records) {
    if (record.toolCallId) {
      session.appendContextReplacement(record);
    }
  }
}

function estimateFixedContextTokens(
  systemPrompt: string,
  tools: readonly unknown[],
): number {
  let toolCharacters = 0;
  try {
    toolCharacters = JSON.stringify(tools).length;
  } catch {
    toolCharacters = 0;
  }
  return Math.ceil((systemPrompt.length + toolCharacters) / 4);
}
