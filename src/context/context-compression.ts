import type { ChatMessage } from "../models/model-chat.js";
import {
  COMPACTION_KEEP_RECENT_TOKENS,
  COMPACTION_RESERVE_TOKENS,
  estimateMessage,
  estimateMessages,
} from "./context-compaction.js";

export type ContextCompressionStageName =
  | "history_prune"
  | "microcompact"
  | "context_collapse"
  | "llm_summary";

export interface ContextCompressionStage {
  name: ContextCompressionStageName;
  applied: boolean;
  changed: boolean;
  tokensBefore: number;
  tokensAfter: number;
  removedMessages: number;
  reason?: string;
}

export interface ContextCompressionReport {
  schemaVersion: 1;
  originalTokens: number;
  finalTokens: number;
  targetTokens: number;
  changed: boolean;
  usedFallbackSummary: boolean;
  summaryError?: string;
  stages: ContextCompressionStage[];
}

export interface PersistedContextCompaction {
  summary: string;
  retainedFromSourceIndex: number;
  tokensBefore: number;
  tokensAfter: number;
  keptMessages: number;
  removedMessages: number;
}

export interface ContextCompressionResult {
  messages: ChatMessage[];
  report: ContextCompressionReport;
  persistentCompaction?: PersistedContextCompaction;
}

export interface ContextCompressionOptions {
  contextWindow: number;
  fixedTokens: number;
  reserveTokens?: number;
  allowLlmSummary?: boolean;
  generateSummary?: (
    messages: readonly ChatMessage[],
  ) => Promise<string | undefined>;
}

interface ProjectedMessage {
  message: ChatMessage;
  sourceIndex: number;
}

const HISTORY_PRUNE_TRIGGER = 0.85;
const HISTORY_PRUNE_TARGET = 0.72;
const MICROCOMPACT_TRIGGER = 0.9;
const MICROCOMPACT_KEEP_RECENT_TOKENS = 12_000;
const LLM_SUMMARY_KEEP_RECENT_TOKENS = 8_000;
const SUMMARY_INPUT_LIMIT_TOKENS = 48_000;
const MICROCOMPACT_PREVIEW_CHARACTERS = 420;
const MIN_TARGET_TOKENS = 2_048;

/**
 * Apply request-only compression in the same spirit as Claude Code:
 * canonical session messages are never mutated here. The returned array is
 * the exact message projection for one model request.
 */
export async function compressContextMessages(
  messages: readonly ChatMessage[],
  options: ContextCompressionOptions,
): Promise<ContextCompressionResult> {
  const reserveTokens = options.reserveTokens ?? COMPACTION_RESERVE_TOKENS;
  const targetTokens = Math.max(
    MIN_TARGET_TOKENS,
    options.contextWindow - options.fixedTokens - reserveTokens,
  );
  const originalTokens = estimateMessages(messages);
  const projected: ProjectedMessage[] = messages.map((message, sourceIndex) => ({
    message,
    sourceIndex,
  }));
  const stages: ContextCompressionStage[] = [];
  let usedFallbackSummary = false;
  let summaryError: string | undefined;
  let persistentCompaction: PersistedContextCompaction | undefined;

  const runStage = (
    name: ContextCompressionStageName,
    shouldRun: boolean,
    reason: string,
    transform: () => number,
  ): void => {
    const tokensBefore = estimateProjectedMessages(projected);
    const removedMessages = transform();
    const tokensAfter = estimateProjectedMessages(projected);
    stages.push({
      name,
      applied: shouldRun,
      changed: tokensAfter < tokensBefore || removedMessages > 0,
      tokensBefore,
      tokensAfter,
      removedMessages,
      ...(shouldRun ? { reason } : {}),
    });
  };

  if (estimateProjectedMessages(projected) > targetTokens * HISTORY_PRUNE_TRIGGER) {
    runStage(
      "history_prune",
      true,
      "request exceeded the historical pruning threshold",
      () => pruneHistory(projected, Math.floor(targetTokens * HISTORY_PRUNE_TARGET)),
    );
  } else {
    stages.push(createSkippedStage("history_prune", projected));
  }

  if (estimateProjectedMessages(projected) > targetTokens * MICROCOMPACT_TRIGGER) {
    runStage(
      "microcompact",
      true,
      "request still exceeded the microcompact threshold",
      () => microcompactOldToolResults(projected, targetTokens),
    );
  } else {
    stages.push(createSkippedStage("microcompact", projected));
  }

  if (estimateProjectedMessages(projected) > targetTokens) {
    runStage(
      "context_collapse",
      true,
      "request remained above the context budget after lightweight compression",
      () => collapseHistory(projected),
    );
  } else {
    stages.push(createSkippedStage("context_collapse", projected));
  }

  const canSummarize =
    options.allowLlmSummary !== false &&
    typeof options.generateSummary === "function" &&
    estimateProjectedMessages(projected) > targetTokens;

  if (canSummarize) {
    const tokensBefore = estimateProjectedMessages(projected);
    const collapse = await summarizeHistory(
      projected,
      options.generateSummary!,
      SUMMARY_INPUT_LIMIT_TOKENS,
      targetTokens,
    );
    const tokensAfter = estimateProjectedMessages(projected);
    usedFallbackSummary = collapse.usedFallback;
    summaryError = collapse.error;
    stages.push({
      name: "llm_summary",
      applied: true,
      changed: tokensAfter < tokensBefore || collapse.removedMessages > 0,
      tokensBefore,
      tokensAfter,
      removedMessages: collapse.removedMessages,
      reason: collapse.usedFallback
        ? "summary model failed; deterministic summary fallback was used"
        : "request remained above the context budget after context collapse",
    });

    if (collapse.retainedFromSourceIndex !== undefined) {
      persistentCompaction = {
        summary: collapse.summary,
        retainedFromSourceIndex: collapse.retainedFromSourceIndex,
        tokensBefore: originalTokens,
        tokensAfter,
        keptMessages: projected.length,
        removedMessages: collapse.retainedFromSourceIndex,
      };
    }
  } else {
    stages.push(createSkippedStage(
      "llm_summary",
      projected,
      options.allowLlmSummary === false
        ? "LLM summary disabled after persistent compaction"
        : "request is within the current compression budget",
    ));
  }

  const finalTokens = estimateProjectedMessages(projected);
  return {
    messages: projected.map((entry) => entry.message),
    report: {
      schemaVersion: 1,
      originalTokens,
      finalTokens,
      targetTokens,
      changed: finalTokens < originalTokens,
      usedFallbackSummary,
      ...(summaryError ? { summaryError } : {}),
      stages,
    },
    ...(persistentCompaction ? { persistentCompaction } : {}),
  };
}

function createSkippedStage(
  name: ContextCompressionStageName,
  projected: readonly ProjectedMessage[],
  reason = "stage threshold was not reached",
): ContextCompressionStage {
  const tokens = estimateProjectedMessages(projected);
  return {
    name,
    applied: false,
    changed: false,
    tokensBefore: tokens,
    tokensAfter: tokens,
    removedMessages: 0,
    reason,
  };
}

function pruneHistory(
  projected: ProjectedMessage[],
  targetTokens: number,
): number {
  const cutIndex = findSafeCutIndex(projected, targetTokens);
  if (cutIndex <= 0) return 0;

  const removed = projected.splice(0, cutIndex);
  const marker: ChatMessage = {
    role: "user",
    content: [
      "[Older conversation history was pruned from this request.]",
      "The canonical session still retains the original messages.",
      "",
      buildHistoryDigest(removed.map((entry) => entry.message), 1_600),
    ].join("\n"),
  };
  projected.unshift({ message: marker, sourceIndex: -1 });
  return removed.length;
}

function microcompactOldToolResults(
  projected: ProjectedMessage[],
  targetTokens: number,
): number {
  const recentBoundary = findRecentMessageBoundary(
    projected,
    MICROCOMPACT_KEEP_RECENT_TOKENS,
  );
  let changed = 0;

  for (let index = 0; index <= recentBoundary; index += 1) {
    const entry = projected[index]!;
    if (entry.message.role !== "tool") continue;
    const compacted = createMicrocompactResult(entry.message);
    if (compacted === entry.message.content) continue;
    projected[index] = {
      ...entry,
      message: { ...entry.message, content: compacted },
    };
    changed += 1;
    if (estimateProjectedMessages(projected) <= targetTokens) break;
  }

  return changed;
}

function findRecentMessageBoundary(
  projected: readonly ProjectedMessage[],
  keepRecentTokens: number,
): number {
  let recentTokens = 0;
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    recentTokens += estimateMessage(projected[index]!.message);
    if (recentTokens >= keepRecentTokens) return index;
  }
  return 0;
}

function collapseHistory(projected: ProjectedMessage[]): number {
  const cutIndex = findSafeCutIndex(
    projected,
    Math.min(COMPACTION_KEEP_RECENT_TOKENS, Math.max(4_000, Math.floor(
      estimateProjectedMessages(projected) * 0.2,
    ))),
  );
  if (cutIndex <= 0) return 0;

  const removed = projected.splice(0, cutIndex);
  const summary: ChatMessage = {
    role: "user",
    content: [
      "[Conversation context collapsed for this request.]",
      "The canonical session remains available to the harness.",
      "",
      buildHistoryDigest(removed.map((entry) => entry.message), 4_000),
    ].join("\n"),
  };
  projected.unshift({ message: summary, sourceIndex: -1 });
  return removed.length;
}

async function summarizeHistory(
  projected: ProjectedMessage[],
  generateSummary: (messages: readonly ChatMessage[]) => Promise<string | undefined>,
  inputLimitTokens: number,
  targetTokens: number,
): Promise<{
  summary: string;
  retainedFromSourceIndex?: number;
  removedMessages: number;
  usedFallback: boolean;
  error?: string;
}> {
  const cutIndex = findSafeCutIndex(projected, LLM_SUMMARY_KEEP_RECENT_TOKENS);
  // If even the latest user turn is larger than the remaining budget, the
  // summary stage is allowed to summarize the entire request. This is the
  // final escape hatch for a single oversized message.
  const removed = cutIndex > 0
    ? projected.slice(0, cutIndex)
    : projected.slice();
  const summaryInput = limitMessages(
    removed.map((entry) => entry.message),
    inputLimitTokens,
  );
  let summary: string | undefined;
  let error: string | undefined;
  try {
    summary = (await generateSummary(summaryInput))?.trim() || undefined;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const usedFallback = !summary;
  const maxSummaryCharacters = Math.max(
    2_000,
    Math.floor(targetTokens * 4 * 0.5),
  );
  const finalSummary = compactText(
    summary ?? buildHistoryDigest(
      removed.map((entry) => entry.message),
      4_000,
    ),
    maxSummaryCharacters,
  );
  const retained = cutIndex > 0 ? projected.slice(cutIndex) : [];
  projected.splice(0, projected.length, {
    sourceIndex: -1,
    message: {
      role: "user",
      content: [
        "[Conversation summary generated for context management.]",
        "Treat this as working memory, not as a new user request.",
        "",
        finalSummary,
      ].join("\n"),
    },
  }, ...retained);

  const retainedFromSourceIndex = retained.find(
    (entry) => entry.sourceIndex >= 0,
  )?.sourceIndex;
  return {
    summary: finalSummary,
    retainedFromSourceIndex,
    removedMessages: removed.length,
    usedFallback,
    ...(error ? { error } : {}),
  };
}

function findSafeCutIndex(
  projected: readonly ProjectedMessage[],
  keepRecentTokens: number,
): number {
  let best = 0;
  for (let index = 0; index < projected.length; index += 1) {
    if (projected[index]?.message.role !== "user") continue;
    if (estimateProjectedMessages(projected.slice(index)) >= keepRecentTokens) {
      best = index;
      continue;
    }
    break;
  }

  if (best > 0) return best;

  // If one message is larger than the retention window, retain the latest
  // user turn instead of cutting through that message or returning no cut.
  for (let index = projected.length - 1; index > 0; index -= 1) {
    if (projected[index]?.message.role === "user") return index;
  }

  // Never cut between an assistant tool call and its tool result.
  return 0;
}

function estimateProjectedMessages(
  projected: readonly ProjectedMessage[],
): number {
  return estimateMessages(projected.map((entry) => entry.message));
}

function createMicrocompactResult(message: ChatMessage): string {
  const preview = compactText(message.content, MICROCOMPACT_PREVIEW_CHARACTERS);
  return [
    "[Older tool result microcompacted for context.]",
    `Tool: ${message.toolName ?? "unknown"}`,
    `Tool call: ${message.toolCallId ?? "unknown"}`,
    "The complete result remains in the canonical session or tool-result store.",
    preview ? `Last known result preview: ${preview}` : "",
  ].filter(Boolean).join("\n");
}

function buildHistoryDigest(
  messages: readonly ChatMessage[],
  maxCharacters: number,
): string {
  const lines: string[] = [];
  for (const message of messages) {
    const label = message.role === "tool"
      ? `tool:${message.toolName ?? "unknown"}`
      : message.role;
    const details = compactText(message.content, 260);
    if (details) lines.push(`- ${label}: ${details}`);
    if (message.toolCalls?.length) {
      lines.push(
        `- assistant tool calls: ${message.toolCalls.map((call) => call.name).join(", ")}`,
      );
    }
  }
  return compactText(lines.join("\n"), maxCharacters);
}

function limitMessages(
  messages: readonly ChatMessage[],
  maxTokens: number,
): ChatMessage[] {
  if (estimateMessages(messages) <= maxTokens) return [...messages];
  const kept: ChatMessage[] = [];
  let tokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const messageTokens = estimateMessage(message);
    if (kept.length > 0 && tokens + messageTokens > maxTokens) break;
    kept.unshift(message);
    tokens += messageTokens;
  }
  return kept;
}

function compactText(value: string, maxCharacters: number): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= maxCharacters) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxCharacters - 3))}...`;
}
