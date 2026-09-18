import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatMessage, ChatToolDefinition } from "../models/model-chat.js";
import type { ContextUsageSnapshot } from "./context-usage.js";
import type { CompactionPlan } from "./context-compaction.js";

export interface ContextTraceMessage {
  index: number;
  role: ChatMessage["role"];
  characters: number;
  tokens: number;
  /** Exact message content sent to the model. */
  content: string;
  preview: string;
  toolCalls?: ChatMessage["toolCalls"];
  toolCallId?: string;
  toolName?: string;
}

export interface ContextTraceEvent {
  schemaVersion: 1;
  timestamp: string;
  phase: "request" | "response" | "compaction";
  runId: string;
  turn: number;
  requestIndex: number;
  provider: string;
  model: string;
  contextWindow: number;
  contextTokens: number;
  estimated: boolean;
  source: string;
  messageCount: number;
  messages?: ContextTraceMessage[];
  /** Exact tool definitions sent to the model. */
  toolDefinitions?: ChatToolDefinition[];
  compaction?: {
    reason: string;
    tokensBefore: number;
    tokensAfter: number;
    removedMessages: number;
    keptMessages: number;
    summary: string;
  };
}

export class ContextTraceLogger {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly getLogPath: () => string) {}

  recordRequest(
    snapshot: ContextUsageSnapshot,
    messages: readonly ChatMessage[],
    tools: readonly ChatToolDefinition[] = [],
  ): Promise<void> {
    return this.record({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      phase: "request",
      runId: snapshot.runId,
      turn: snapshot.turn,
      requestIndex: snapshot.requestIndex,
      provider: snapshot.provider,
      model: snapshot.model,
      contextWindow: snapshot.contextWindow,
      contextTokens: snapshot.contextTokens,
      estimated: snapshot.estimated,
      source: snapshot.source,
      messageCount: messages.length,
      messages: messages.map((message, index) => ({
        index,
        role: message.role,
        characters: message.content.length,
        tokens: Math.ceil(message.content.length / 4),
        content: message.content,
        preview: preview(message.content),
        ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
      })),
      toolDefinitions: [...tools],
    });
  }

  recordResponse(snapshot: ContextUsageSnapshot, messages: readonly ChatMessage[]): Promise<void> {
    return this.record({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      phase: "response",
      runId: snapshot.runId,
      turn: snapshot.turn,
      requestIndex: snapshot.requestIndex,
      provider: snapshot.provider,
      model: snapshot.model,
      contextWindow: snapshot.contextWindow,
      contextTokens: snapshot.contextTokens,
      estimated: snapshot.estimated,
      source: snapshot.source,
      messageCount: messages.length,
    });
  }

  recordCompaction(
    snapshot: ContextUsageSnapshot,
    reason: string,
    plan: CompactionPlan,
  ): Promise<void> {
    return this.record({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      phase: "compaction",
      runId: snapshot.runId,
      turn: snapshot.turn,
      requestIndex: snapshot.requestIndex,
      provider: snapshot.provider,
      model: snapshot.model,
      contextWindow: snapshot.contextWindow,
      contextTokens: plan.tokensAfter,
      estimated: true,
      source: "compaction",
      messageCount: plan.keptMessages.length,
      compaction: {
        reason,
        tokensBefore: plan.tokensBefore,
        tokensAfter: plan.tokensAfter,
        removedMessages: plan.removedMessages,
        keptMessages: plan.keptMessages.length,
        summary: plan.summary,
      },
    });
  }

  private record(event: ContextTraceEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        const path = this.getLogPath();
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line, "utf8");
      })
      .catch(() => undefined);
    return this.writeQueue;
  }
}

function preview(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= 2_000) return singleLine;
  return `${singleLine.slice(0, 1_997)}...`;
}
