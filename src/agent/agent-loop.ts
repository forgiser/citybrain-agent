import type { AuthStorage } from "../auth/auth-storage.js";
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
import { SessionManager } from "../session/session-manager.js";
import type {
  ToolCallContext,
  ToolExecutionOutcome,
  ToolRegistry,
} from "../tools/tool-registry.js";

export interface ToolExecutionStarted {
  name: string;
  argumentsText: string;
}

export interface ToolExecutionResult extends ToolExecutionStarted {
  ok: boolean;
  result: string;
}

/**
 * Structured events yielded by AgentLoop.run(). The consumer (UI) pulls them
 * with `for await` and renders incrementally - no callbacks, no folding.
 */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | ({ type: "tool_started" } & ToolExecutionStarted)
  | ({ type: "tool_result" } & ToolExecutionResult)
  | ({ type: "agent_status" } & AgentStatusUpdate);

import type { AgentStatusUpdate } from "./agent-status.js";
export type { AgentStatus, AgentStatusUpdate } from "./agent-status.js";

export class AgentLoop {
  constructor(
    private readonly modelRuntime: ModelRuntime,
    private readonly authStorage: AuthStorage,
    private session: SessionManager,
    private readonly tools: ToolRegistry,
  ) {}

  getSelectedModel(): ModelDefinition | undefined {
    return this.modelRuntime.getSelectedModel();
  }

  async *run(
    input: string,
    options: StreamChatOptions = {},
  ): AsyncGenerator<AgentEvent, string, undefined> {
    const model = this.modelRuntime.getSelectedModel() ?? this.modelRuntime.ensureSelection();
    if (!model) {
      throw new Error("No active model. Run /login and select a model first.");
    }

    const credential = this.authStorage.get(model.provider);
    if (!credential) {
      throw new Error("Provider is not logged in: " + model.provider);
    }

    const systemPrompt = await buildSystemPromptForCwd(this.session.getCwd());
    const messages: ChatMessage[] = [
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

    for (let turn = 0; turn < 4; turn++) {
      let response = "";
      let thinking = "";
      const toolCalls = new Map<number, ChatToolCall>();

      for await (const delta of streamModelChat(model, credential, messages, {
        ...options,
        tools: this.tools.definitions(),
        onUsage: (nextUsage) => {
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

      if (toolCalls.size === 0) {
        finalResponse = response;
        finalThinking += thinking;
        break;
      }

      finalThinking += thinking;
      const resolvedToolCalls = [...toolCalls.values()];
      messages.push({
        role: "assistant",
        content: response,
        toolCalls: resolvedToolCalls,
      });

      const outcomes = yield* this.executeToolTurn(resolvedToolCalls);
      for (let index = 0; index < resolvedToolCalls.length; index++) {
        const outcome = outcomes[index]!;
        messages.push({
          role: "tool",
          content: outcome.content,
          toolCallId: resolvedToolCalls[index]!.id,
          toolName: resolvedToolCalls[index]!.name,
        });
      }
    }

    if (!finalResponse) {
      throw new Error("The model did not produce a final response after using tools.");
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
  }

  /**
   * Bridge the concurrent tool scheduler into the event stream. Tools emit
   * events into a queue as they start/complete; this generator drains the
   * queue and yields until every call has settled, then returns the outcomes
   * in the original call order.
   */
  private async *executeToolTurn(
    resolvedToolCalls: ChatToolCall[],
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

    const runner = this.startToolCalls(resolvedToolCalls, emit).then(
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
  ): Promise<ToolExecutionOutcome[]> {
    const settlements: Promise<ToolExecutionOutcome>[] = new Array(resolvedToolCalls.length);
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
      };
      const settlement = this.tools
        .execute(toolCall.name, toolCall.arguments, context)
        .then((outcome) => {
          emit({
            type: "tool_result",
            name: toolCall.name,
            argumentsText: toolCall.arguments,
            ok: outcome.ok,
            result: outcome.content,
          });
          return outcome;
        });
      settlements[index] = settlement;
      executing.add(settlement);
      void settlement.catch(() => undefined).finally(() => executing.delete(settlement));
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
