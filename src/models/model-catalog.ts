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
  if (model.contextWindow && model.contextWindow > 0) {
    return model;
  }

  const known = KNOWN_CONTEXT_WINDOWS.find(
    (candidate) =>
      candidate.provider === model.provider && candidate.matches.test(model.id),
  );
  return known
    ? { ...model, contextWindow: known.contextWindow }
    : model;
}

export function getModelReference(model: ModelDefinition): string {
  return `${model.provider}/${model.id}`;
}

export function findModel(models: readonly ModelDefinition[], reference: string): ModelDefinition | undefined {
  const normalized = reference.trim().toLowerCase();
  return models.find((model) => getModelReference(model).toLowerCase() === normalized);
}
