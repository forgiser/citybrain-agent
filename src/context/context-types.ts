/**
 * Core types for the context-assembly layer.
 *
 * Mirrors Claude Code 2's `context.ts` abstraction: every context piece is a
 * named block returned as a `{ [key: string]: string }` dictionary — the key
 * is the block name, the value its rendered content. Keeping blocks named and
 * separate is what lets callers reason about token budgets and build a stable
 * cache-key prefix later.
 */

/** A named context block. `key` = block identity (used in cache key), `value` = rendered text. */
export interface ContextBlock {
  key: string;
  value: string;
}

export type ContextBlocks = Record<string, string>;

/**
 * The assembled system prompt, split into the same three dimensions Claude
 * Code 2 uses in `fetchSystemPromptParts`. Keeping them separate (rather than
 * one giant string) preserves the ability to:
 *  - drop/replace any dimension independently (e.g. disable memory index);
 *  - build a cache-key prefix from the blocks;
 *  - attribute token budget per dimension in a context meter.
 */
export interface SystemContextParts {
  /** Static behavior + domain role (everything the model "is"). */
  defaultSystemPrompt: ContextBlocks;
  /** Per-user / per-project instruction + long-term memory index (L0/L2). */
  userContext: ContextBlocks;
  /** Live working state: current analysis task progress (L1). */
  systemContext: ContextBlocks;
}

/** Inputs every context builder needs. */
export interface ContextBuildInputs {
  /** Semantic role/mission statement. Optional; a built-in default exists. */
  rolePrompt?: string;
  /** Project-scoped instructions file path (like CLAUDE.md). Optional. */
  projectInstructionPath?: string;
  /** Current analysis task markdown content (ANALYSIS_TASK.md, L1). */
  analysisTask?: string;
  /** Memory index markdown content (MEMORY.md, L2). Optional. */
  memoryIndex?: string;
  /** Skills index markdown content (SKILLS_index.md, L3). Optional. */
  skillsIndex?: string;
  /** Ready-to-run QGIS runtime summary line, when configured. */
  qgisRuntimeSummary?: string;
  /** Absolute paths the agent is rooted in (for workspace awareness). */
  additionalWorkingDirectories?: string[];
  /** Today's date string, injected as `Today's date: <date>`. */
  today?: string;
}