import type { ChatMessage } from "../models/model-chat.js";
import { estimateMessages } from "./context-compaction.js";
import {
  persistToolResult,
  type StoredToolResult,
} from "./tool-result-store.js";

export interface ToolResultBudget {
  /** Maximum inline result size, estimated as four characters per token. */
  maxTokens: number;
}

export interface PersistedToolResultProjection extends StoredToolResult {
  toolCallId?: string;
  toolName?: string;
  replacement: string;
  originalTokens: number;
  projectedTokens: number;
}

export interface ContextProjectionStage {
  name: "tool_result_budget" | "tool_result_batch_budget";
  applied: boolean;
  changed: boolean;
  inspectedMessages: number;
  changedMessages: number;
}

export interface ContextProjectionReport {
  schemaVersion: 1;
  originalTokens: number;
  projectedTokens: number;
  originalCharacters: number;
  projectedCharacters: number;
  changed: boolean;
  persistedToolResults: PersistedToolResultProjection[];
  reusedToolResults: string[];
  persistenceFailures: Array<{
    toolCallId?: string;
    toolName?: string;
    error: string;
  }>;
  stages: ContextProjectionStage[];
}

export interface ContextProjectionResult {
  messages: ChatMessage[];
  report: ContextProjectionReport;
  newReplacements: PersistedToolResultProjection[];
}

export interface ContextProjectionState {
  seenToolCallIds: Set<string>;
  replacements: Map<string, PersistedToolResultProjection>;
}

/**
 * Tool-specific inline budgets. read_file already has an explicit line and
 * character limit, so its result is left inline. Other tools can produce
 * unbounded catalog, diagnostic, or delegated output and are persisted only
 * when a request actually exceeds their budget.
 */
export const DEFAULT_TOOL_RESULT_BUDGETS: Readonly<Record<string, ToolResultBudget>> = {
  read_file: { maxTokens: Number.POSITIVE_INFINITY },
  list_files: { maxTokens: 4_000 },
  list_qgis_algorithms: { maxTokens: 8_000 },
  describe_qgis_algorithm: { maxTokens: 12_000 },
  run_qgis_algorithm: { maxTokens: 8_000 },
  delegate: { maxTokens: 8_000 },
};

const DEFAULT_RESULT_BUDGET: ToolResultBudget = { maxTokens: 8_000 };
const MAX_TOOL_RESULT_BATCH_TOKENS = 16_000;
const CHARS_PER_TOKEN = 4;
const MAX_PREVIEW_CHARACTERS = 6_000;

export async function projectContextMessages(
  messages: readonly ChatMessage[],
  workspaceDir: string,
  budgets: Readonly<Record<string, ToolResultBudget>> = DEFAULT_TOOL_RESULT_BUDGETS,
  state: ContextProjectionState = createContextProjectionState(),
): Promise<ContextProjectionResult> {
  const originalTokens = estimateMessages(messages);
  const originalCharacters = messages.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  const persistedToolResults: PersistedToolResultProjection[] = [];
  const reusedToolResults: string[] = [];
  const newReplacements: PersistedToolResultProjection[] = [];
  const changedIndexes = new Set<number>();
  const persistenceFailures: ContextProjectionReport["persistenceFailures"] = [];
  const projectedMessages = [...messages];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "tool") continue;

    const toolCallId = message.toolCallId;
    if (toolCallId && state.seenToolCallIds.has(toolCallId)) {
      const priorReplacement = state.replacements.get(toolCallId);
      if (priorReplacement) {
        projectedMessages[index] = {
          ...message,
          content: priorReplacement.replacement,
        };
        changedIndexes.add(index);
        persistedToolResults.push(priorReplacement);
        reusedToolResults.push(toolCallId);
      }
      continue;
    }

    const budget = budgets[message.toolName ?? ""] ?? DEFAULT_RESULT_BUDGET;
    if (!Number.isFinite(budget.maxTokens)) {
      if (toolCallId) state.seenToolCallIds.add(toolCallId);
      continue;
    }

    const maxCharacters = Math.max(1, Math.floor(budget.maxTokens * CHARS_PER_TOKEN));
    if (message.content.length <= maxCharacters) {
      if (toolCallId) state.seenToolCallIds.add(toolCallId);
      continue;
    }

    const replacement = await persistReplacement(
      message,
      workspaceDir,
      maxCharacters,
      persistenceFailures,
    );
    if (!replacement) {
      if (toolCallId) state.seenToolCallIds.add(toolCallId);
      continue;
    }
    applyReplacement(projectedMessages, index, message, replacement);
    if (toolCallId) {
      state.seenToolCallIds.add(toolCallId);
      state.replacements.set(toolCallId, replacement);
    }
    persistedToolResults.push(replacement);
    newReplacements.push(replacement);
  }

  // Claude Code also applies an aggregate budget to a batch of tool results.
  // Our transcript stores each result as a ChatMessage, so a contiguous run of
  // tool messages is the equivalent batch. Only new, not-yet-replaced results
  // are eligible; prior decisions remain frozen for prompt stability.
  for (const [start, end] of findToolMessageBatches(messages)) {
    let batchTokens = estimateMessages(projectedMessages.slice(start, end));
    if (batchTokens <= MAX_TOOL_RESULT_BATCH_TOKENS) continue;

    const candidates = [];
    for (let index = start; index < end; index += 1) {
      const original = messages[index]!;
      if (original.role !== "tool" || !original.toolCallId) continue;
      if (state.replacements.has(original.toolCallId)) continue;
      if (!state.seenToolCallIds.has(original.toolCallId)) continue;
      if (projectedMessages[index]!.content !== original.content) continue;
      if (!isAggregateBudgetEligible(original, budgets)) continue;
      candidates.push({
        index,
        message: original,
        size: estimateTextTokens(original.content),
      });
    }
    candidates.sort((left, right) => right.size - left.size);

    for (const candidate of candidates) {
      if (batchTokens <= MAX_TOOL_RESULT_BATCH_TOKENS) break;
      const budget = budgets[candidate.message.toolName ?? ""] ?? DEFAULT_RESULT_BUDGET;
      const replacement = await persistReplacement(
        candidate.message,
        workspaceDir,
        Math.floor(budget.maxTokens * CHARS_PER_TOKEN),
        persistenceFailures,
      );
      if (!replacement) continue;
      applyReplacement(projectedMessages, candidate.index, candidate.message, replacement);
      changedIndexes.add(candidate.index);
      state.replacements.set(candidate.message.toolCallId!, replacement);
      persistedToolResults.push(replacement);
      newReplacements.push(replacement);
      batchTokens = estimateMessages(projectedMessages.slice(start, end));
    }
  }

  const projectedCharacters = projectedMessages.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  const projectedTokens = estimateMessages(projectedMessages);

  return {
    messages: projectedMessages,
    report: {
      schemaVersion: 1,
      originalTokens,
      projectedTokens,
      originalCharacters,
      projectedCharacters,
      changed: changedIndexes.size > 0,
      persistedToolResults,
      reusedToolResults,
      persistenceFailures,
      stages: [
        {
          name: "tool_result_budget",
          applied: true,
          changed: changedIndexes.size > 0,
          inspectedMessages: messages.length,
          changedMessages: changedIndexes.size,
        },
        {
          name: "tool_result_batch_budget",
          applied: true,
          changed: newReplacements.length > 0,
          inspectedMessages: messages.filter((message) => message.role === "tool").length,
          changedMessages: newReplacements.length,
        },
      ],
    },
    newReplacements,
  };
}

export function createContextProjectionState(): ContextProjectionState {
  return {
    seenToolCallIds: new Set(),
    replacements: new Map(),
  };
}

export function restoreContextProjectionState(
  records: readonly PersistedToolResultProjection[],
): ContextProjectionState {
  const state = createContextProjectionState();
  for (const record of records) {
    if (!record.toolCallId) continue;
    state.seenToolCallIds.add(record.toolCallId);
    state.replacements.set(record.toolCallId, record);
  }
  return state;
}

function applyReplacement(
  projectedMessages: ChatMessage[],
  index: number,
  message: ChatMessage,
  replacement: PersistedToolResultProjection,
): void {
  projectedMessages[index] = {
    ...message,
    content: replacement.replacement,
  };
}

async function persistReplacement(
  message: ChatMessage,
  workspaceDir: string,
  maxCharacters: number,
  persistenceFailures: ContextProjectionReport["persistenceFailures"],
): Promise<PersistedToolResultProjection | undefined> {
  let stored: StoredToolResult;
  try {
    stored = await persistToolResult(
      workspaceDir,
      message.toolCallId,
      message.toolName,
      message.content,
    );
  } catch (error) {
    persistenceFailures.push({
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  const replacement = buildPersistedToolResultMessage(message, stored, maxCharacters);
  return {
    ...stored,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    replacement,
    originalTokens: estimateTextTokens(message.content),
    projectedTokens: estimateTextTokens(replacement),
  };
}

function buildPersistedToolResultMessage(
  message: ChatMessage,
  stored: StoredToolResult,
  maxCharacters: number,
): string {
  const previewCharacters = Math.min(
    MAX_PREVIEW_CHARACTERS,
    Math.max(1_000, Math.floor(maxCharacters / 3)),
  );
  const preview = createPreview(message.content, previewCharacters);
  return [
    "[Tool result projected for context]",
    `Tool: ${message.toolName ?? "unknown"}`,
    `Original size: ${message.content.length} characters (~${estimateTextTokens(message.content)} tokens)`,
    `Full result saved to: ${stored.path}`,
    "",
    "Preview:",
    preview.text,
    preview.hasMore ? "..." : "",
    "",
    "Use read_file with the saved path and offset/limit if the full result is needed.",
  ]
    .filter(Boolean)
    .join("\n");
}

function createPreview(
  content: string,
  maxCharacters: number,
): { text: string; hasMore: boolean } {
  if (content.length <= maxCharacters) {
    return { text: content, hasMore: false };
  }

  const headCharacters = Math.floor(maxCharacters * 0.7);
  const tailCharacters = maxCharacters - headCharacters;
  return {
    text: [
      content.slice(0, headCharacters),
      "",
      "[...middle omitted...]",
      "",
      content.slice(-tailCharacters),
    ].join("\n"),
    hasMore: true,
  };
}

function estimateTextTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / CHARS_PER_TOKEN));
}

function findToolMessageBatches(
  messages: readonly ChatMessage[],
): Array<[number, number]> {
  const batches: Array<[number, number]> = [];
  let start = -1;
  for (let index = 0; index <= messages.length; index += 1) {
    const isTool = index < messages.length && messages[index]?.role === "tool";
    if (isTool && start < 0) {
      start = index;
      continue;
    }
    if (!isTool && start >= 0) {
      batches.push([start, index]);
      start = -1;
    }
  }
  return batches;
}

function isAggregateBudgetEligible(
  message: ChatMessage,
  budgets: Readonly<Record<string, ToolResultBudget>>,
): boolean {
  const budget = budgets[message.toolName ?? ""] ?? DEFAULT_RESULT_BUDGET;
  return Number.isFinite(budget.maxTokens);
}
