/**
 * Context-assembly layer — a single entry point, mirroring Claude Code 2's
 * concentrated `queryContext.ts` external surface (kept in one module to avoid
 * circular-import graphs in a small project).
 */
export {
  buildContext,
  buildDynamicSections,
  buildStaticSections,
  buildSystemSections,
  DEFAULT_QB_ROLE_PROMPT,
} from "./context-builder.js";
export {
  buildSystemPromptForCwd,
  flattenSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "./context-assembly.js";
export {
  clearSystemPromptSections,
  resolveSystemPromptSections,
  systemPromptSection,
  volatileSystemPromptSection,
  type SystemPromptSection,
} from "./context-section.js";
export {
  getAnalysisTaskPath,
  readAnalysisTask,
  readMemoryIndex,
  readProjectInstruction,
  readSkillsIndex,
  writeAnalysisTask,
} from "./context-store.js";
export {
  COMPACT_BUFFER_TOKENS,
  CONTEXT_WINDOW_DEFAULT,
  getAutocompactThreshold,
  getContextWindowForModel,
} from "./context-window.js";
export {
  createEstimatedUsageSnapshot,
  createHybridUsageSnapshot,
  createProviderUsageSnapshot,
  estimateChatContextTokens,
  getContextTokensFromUsage,
  getPromptTokensFromUsage,
  type ContextUsageSnapshot,
  type ContextUsageSource,
  type ContextUsageStage,
  type ContextWindowSource,
} from "./context-usage.js";
export {
  COMPACTION_KEEP_RECENT_TOKENS,
  COMPACTION_RESERVE_TOKENS,
  createCompactionPlan,
  estimateMessage,
  estimateMessages,
  type CompactionPlan,
} from "./context-compaction.js";
export type {
  ContextBlock,
  ContextBlocks,
  ContextBuildInputs,
  SystemContextParts,
} from "./context-types.js";
