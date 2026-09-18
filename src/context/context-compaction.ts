import type { ChatMessage } from "../models/model-chat.js";

export const COMPACTION_RESERVE_TOKENS = 16_384;
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000;

export interface CompactionPlan {
  summary: string;
  keptMessages: ChatMessage[];
  tokensBefore: number;
  tokensAfter: number;
  removedMessages: number;
}

/**
 * Build a deterministic checkpoint from the old conversation. This keeps the
 * MVP predictable and avoids recursively calling the model while compacting.
 */
export function createCompactionPlan(
  messages: readonly ChatMessage[],
  keepRecentTokens = COMPACTION_KEEP_RECENT_TOKENS,
): CompactionPlan | undefined {
  if (messages.length < 2) return undefined;

  const tokensBefore = estimateMessages(messages);
  let accumulated = 0;
  let cutIndex = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    accumulated += estimateMessage(messages[index]!);
    if (accumulated >= keepRecentTokens) {
      cutIndex = findSafeCutIndex(messages, index);
      break;
    }
  }

  if (cutIndex <= 0 || cutIndex >= messages.length) return undefined;

  const removed = messages.slice(0, cutIndex);
  const keptMessages = messages.slice(cutIndex);
  const summary = buildCheckpointSummary(removed);
  const summaryMessage: ChatMessage = {
    role: "user",
    content: [
      "The earlier conversation was compacted into this checkpoint.",
      "Use it as working memory and continue directly.",
      "",
      summary,
    ].join("\n"),
  };
  const tokensAfter = estimateMessages([summaryMessage, ...keptMessages]);

  return {
    summary,
    keptMessages: [summaryMessage, ...keptMessages],
    tokensBefore,
    tokensAfter,
    removedMessages: removed.length,
  };
}

export function estimateMessages(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessage(message), 0);
}

export function estimateMessage(message: ChatMessage): number {
  let characters = message.content.length;
  if (message.toolCallId) characters += message.toolCallId.length;
  if (message.toolName) characters += message.toolName.length;
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      characters += call.id.length + call.name.length + call.arguments.length;
    }
  }
  return Math.max(1, Math.ceil(characters / 4));
}

function findSafeCutIndex(messages: readonly ChatMessage[], candidate: number): number {
  for (let index = candidate; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") return index;
  }
  return candidate;
}

function buildCheckpointSummary(messages: readonly ChatMessage[]): string {
  const lines: string[] = [
    "## Conversation Checkpoint",
    `Messages summarized: ${messages.length}`,
  ];

  for (const message of messages) {
    const label = message.role === "tool"
      ? `tool:${message.toolName ?? "unknown"}`
      : message.role;
    const text = compactPreview(message.content);
    if (text) lines.push(`- ${label}: ${text}`);
    if (message.toolCalls?.length) {
      lines.push(
        `- assistant tool calls: ${message.toolCalls.map((call) => call.name).join(", ")}`,
      );
    }
  }

  return lines.join("\n");
}

function compactPreview(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= 280) return singleLine;
  return `${singleLine.slice(0, 277)}...`;
}
