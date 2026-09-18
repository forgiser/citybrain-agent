import {
  buildContext,
  buildDynamicSections,
  buildStaticSections,
  buildVolatileSections,
} from "./context-builder.js";
import { resolveSystemPromptSections } from "./context-section.js";
import type {
  ContextBuildInputs,
  SystemContextParts,
} from "./context-types.js";

/**
 * Literal marker that splits the static (cacheable) system-prompt base from
 * the dynamic (registry-managed) entries. This is a hard anchor: anything
 * upstream that needs to reason about a stable cache prefix splits the
 * flattened prompt on this exact string. See Claude Code 2's
 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` for the same idiom.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
export const SYSTEM_PROMPT_VOLATILE_BOUNDARY =
  "__SYSTEM_PROMPT_VOLATILE_BOUNDARY__";

/**
 * Flatten the three context-part dictionaries into a single system-prompt
 * string, keyed blocks in a stable order. This is the block-dictionary view
 * for token metering / cache-key accounting, NOT what gets sent to the model
 * (that goes through `buildSystemPromptForCwd`, which adds the boundary
 * marker). Order: static base (role first), then dynamic — separate the two
 * with the boundary marker so the static prefix is identifiable.
 */
export function flattenSystemPrompt(parts: SystemContextParts): string {
  const order: Array<[string, keyof SystemContextParts]> = [
    ["defaultSystemPrompt", "defaultSystemPrompt"],
    ["userContext", "userContext"],
    ["systemContext", "systemContext"],
  ];
  const sections: string[] = [];
  let insertedBoundary = false;
  for (const [, dimension] of order) {
    for (const [key, value] of Object.entries(parts[dimension])) {
      if (value.trim()) sections.push(value.trim());
    }
    // Boundary after the static dimension, before the dynamic ones.
    if (dimension === "defaultSystemPrompt" && !insertedBoundary) {
      sections.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
      insertedBoundary = true;
    }
  }
  return sections.join("\n\n");
}

/**
 * One-call convenience for the agent loop: resolve the static base and the
 * registry-managed dynamic sections separately, joining them with the
 * boundary marker so the static prefix is byte-identical when stable sections
 * are cached. A caller that wants a whole-session stable prefix caches this
 * result itself.
 */
export async function buildSystemPromptForCwd(
  cwd: string,
  inputs: ContextBuildInputs = {},
): Promise<string> {
  const [staticParts, dynamicParts, volatileParts] = await Promise.all([
    resolveSystemPromptSections(buildStaticSections(inputs)),
    resolveSystemPromptSections(buildDynamicSections(cwd, inputs)),
    resolveSystemPromptSections(buildVolatileSections(cwd, inputs)),
  ]);
  const joinParts = (list: (string | null)[]): string =>
    list.filter((s): s is string => s !== null).join("\n\n");
  const staticBase = joinParts(staticParts);
  const dynamicBase = joinParts(dynamicParts);
  const volatileBase = joinParts(volatileParts);
  const dynamicSections = [
    dynamicBase,
    volatileBase
      ? `${SYSTEM_PROMPT_VOLATILE_BOUNDARY}\n\n${volatileBase}`
      : "",
  ].filter(Boolean);
  const dynamicPrompt = dynamicSections.join("\n\n");
  if (!staticBase) return dynamicPrompt;
  if (!dynamicPrompt) return staticBase;
  return `${staticBase}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${dynamicPrompt}`;
}
