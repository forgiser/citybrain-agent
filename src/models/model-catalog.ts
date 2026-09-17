export interface ModelDefinition {
  provider: string;
  id: string;
  name: string;
  description: string;
  contextWindow?: number;
  source: "provider_probe" | "cache";
}

export function getModelReference(model: ModelDefinition): string {
  return `${model.provider}/${model.id}`;
}

export function findModel(models: readonly ModelDefinition[], reference: string): ModelDefinition | undefined {
  const normalized = reference.trim().toLowerCase();
  return models.find((model) => getModelReference(model).toLowerCase() === normalized);
}
