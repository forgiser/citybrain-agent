export interface ModelDefinition {
  provider: string;
  id: string;
  name: string;
  description: string;
  contextWindow?: number;
  source: "provider_probe" | "cache";
}

/**
 * Provider model-list endpoints do not always expose the real context limit.
 * Keep curated capability metadata for known models, matching the strategy
 * used by pi's generated model catalog.
 */
const KNOWN_CONTEXT_WINDOWS: readonly {
  provider: string;
  matches: RegExp;
  contextWindow: number;
}[] = [
  {
    provider: "deepseek",
    matches: /^(?:deepseek-flash|deepseek-v4(?:$|-)|deepseek-v4-pro(?:$|-))/iu,
    contextWindow: 1_000_000,
  },
];

export function applyKnownModelMetadata(model: ModelDefinition): ModelDefinition {
  const known = KNOWN_CONTEXT_WINDOWS.find(
    (candidate) =>
      candidate.provider === model.provider && candidate.matches.test(model.id),
  );
  if (!known) return model;

  // Provider model-list endpoints have been observed to report a generic
  // 128k limit for DeepSeek models whose actual input window is 1M. Prefer
  // the curated capability when it is larger than provider metadata.
  if (!model.contextWindow || model.contextWindow < known.contextWindow) {
    return { ...model, contextWindow: known.contextWindow };
  }
  return model;
}

export function getModelReference(model: ModelDefinition): string {
  return `${model.provider}/${model.id}`;
}

export function findModel(models: readonly ModelDefinition[], reference: string): ModelDefinition | undefined {
  const normalized = reference.trim().toLowerCase();
  return models.find((model) => getModelReference(model).toLowerCase() === normalized);
}
