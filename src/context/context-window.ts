/**
 * Model-aware context window resolution, mirroring Claude Code 2's
 * `getContextWindowForModel`. CityBrain currently applies a single
 * DEFAULT_CONTEXT_WINDOW regardless of model; this centralizes the mapping so
 * larger-window models (or tool-enriched multiprovider accounts) can raise the
 * ceiling without touching session accounting.
 */

/** Default window when the model id isn't recognized. */
export const CONTEXT_WINDOW_DEFAULT = 128_000;
/** Largest model we expect; used to protect against silly overrides. */
const CONTEXT_WINDOW_CEILING = 1_000_000;

/** Reserve for LLM compaction output; surfaced as "Autocompact buffer". */
export const COMPACT_BUFFER_TOKENS = 13_000;

/** Models whose ids match are known to exceed the default window. */
const LARGE_WINDOW_PATTERN =
  /\[1m\]|1m\b|deepseek-(?:flash|v4)|claude-sonnet-4|opus-4|gemini-2\.0-pro|x-/iu;

/**
 * Resolve the effective context window for a model id. Falls back to the
 * default; honors an explicit override for proven-large models.
 */
export function getContextWindowForModel(modelId: string): number {
  if (!modelId) return CONTEXT_WINDOW_DEFAULT;
  if (LARGE_WINDOW_PATTERN.test(modelId)) {
    return Math.min(1_000_000, CONTEXT_WINDOW_CEILING);
  }
  return CONTEXT_WINDOW_DEFAULT;
}

/** Effective threshold at which autocompact would fire, per Claude Code. */
export function getAutocompactThreshold(modelId: string): number {
  return getContextWindowForModel(modelId) - COMPACT_BUFFER_TOKENS;
}
