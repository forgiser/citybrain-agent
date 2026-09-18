/**
 * Named system-prompt section registry, mirroring Claude Code 2's
 * `systemPromptSection` / `resolveSystemPromptSections`.
 *
 * Every block of the system prompt is named. Stable sections may be memoized
 * by name; volatile sections are recomputed for every request. This keeps the
 * static prefix byte-identical without allowing project state or task progress
 * to become stale.
 *
 * Two kinds:
 *  - `systemPromptSection(name, compute)`     — cached, stable across turns
 *  - `volatileSystemPromptSection(name, ...)` — recomputed every turn; this
 *    deliberately breaks the prompt cache whenever its value changes, so it is
 *    reserved for genuinely live state (e.g. the L1 ANALYSIS_TASK ledger that
 *    advances as tools settle).
 */
export type SystemPromptSection = {
  name: string;
  compute: () => string | null | Promise<string | null>;
  /** true => recompute every turn and bust the cache. */
  cacheBreak: boolean;
  /** Optional rationale, required in spirit for cache-breaking sections. */
  reason?: string;
};

/** Create a cached system-prompt section. Computed once, cached until cleared. */
export function systemPromptSection(
  name: string,
  compute: () => string | null | Promise<string | null>,
): SystemPromptSection {
  return { name, compute, cacheBreak: false };
}

/**
 * Create a volatile section that recomputes every turn. This WILL break the
 * prompt cache when the value changes. `reason` documents why that is
 * necessary (kept on the object for observability/diagnostics).
 */
export function volatileSystemPromptSection(
  name: string,
  compute: () => string | null | Promise<string | null>,
  reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true, reason };
}

/** Process-scoped cache for stable sections. Volatile sections bypass it. */
const sectionCache = new Map<string, string | null>();

/**
 * Resolve sections against the cache. Cached (non-volatile) sections reuse
 * their memoized value; volatile sections always recompute and refresh it.
 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  return Promise.all(
    sections.map(async (s) => {
      if (!s.cacheBreak && sectionCache.has(s.name)) {
        return sectionCache.get(s.name) ?? null;
      }
      const value = await s.compute();
      sectionCache.set(s.name, value);
      return value;
    }),
  );
}

/** Forget all cached sections. Called on /clear and on new session. */
export function clearSystemPromptSections(): void {
  sectionCache.clear();
}
