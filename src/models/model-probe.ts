import type { ApiKeyCredential } from "../auth/auth-storage.js";
import {
  applyKnownModelMetadata,
  type ModelDefinition,
} from "./model-catalog.js";

export interface ModelProbeOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ProviderProbe {
  provider: string;
  endpoint: string;
  headers(credential: ApiKeyCredential): Record<string, string>;
  parse(provider: string, payload: unknown): ModelDefinition[];
}

interface GenericModelRecord {
  id?: unknown;
  model?: unknown;
  name?: unknown;
  display_name?: unknown;
  displayName?: unknown;
  created_at?: unknown;
  description?: unknown;
  context_length?: unknown;
  contextWindow?: unknown;
  context_window?: unknown;
  input_token_limit?: unknown;
  maxInputTokens?: unknown;
  top_provider?: {
    context_length?: unknown;
  };
  supportedGenerationMethods?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
}

const providerProbes: readonly ProviderProbe[] = [
  {
    provider: "openai",
    endpoint: "https://api.openai.com/v1/models",
    headers: bearerHeaders,
    parse: parseOpenAiModels,
  },
  {
    provider: "anthropic",
    endpoint: "https://api.anthropic.com/v1/models",
    headers: (credential) => ({
      "x-api-key": credential.key,
      "anthropic-version": "2023-06-01",
    }),
    parse: parseAnthropicModels,
  },
  {
    provider: "google",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: (credential) => ({
      "x-goog-api-key": credential.key,
    }),
    parse: parseGoogleModels,
  },
  {
    provider: "deepseek",
    endpoint: "https://api.deepseek.com/models",
    headers: bearerHeaders,
    parse: parseOpenAiModels,
  },
  {
    provider: "qwen",
    endpoint: "https://dashscope.aliyuncs.com/api/v1/models",
    headers: bearerHeaders,
    parse: parseOpenAiModels,
  },
  {
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/models",
    headers: bearerHeaders,
    parse: parseOpenRouterModels,
  },
];

export async function probeProviderModels(
  providerId: string,
  credential: ApiKeyCredential,
  options: ModelProbeOptions = {},
): Promise<ModelDefinition[]> {
  const probe = providerProbes.find((candidate) => candidate.provider === providerId);
  if (!probe) {
    throw new Error(`No model probe is registered for provider: ${providerId}`);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(probe.endpoint, {
      method: "GET",
      headers: probe.headers(credential),
      signal,
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${getProviderError(payload)}`);
    }

    const models = probe.parse(providerId, payload);
    if (models.length === 0) {
      throw new Error("The provider returned no text-generation models");
    }
    return models;
  } finally {
    clearTimeout(timeout);
  }
}

function bearerHeaders(credential: ApiKeyCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.key}`,
  };
}

function parseOpenAiModels(provider: string, payload: unknown): ModelDefinition[] {
  const records = getRecords(payload);
  return records
    .filter(isTextModel)
    .map((record) => {
      const id = getModelId(record);
      return applyKnownModelMetadata({
        provider,
        id,
        name: getString(record.name) ?? id,
        description: getString(record.description) ?? `Model returned by ${provider}`,
        ...getContextWindowField(record),
        source: "provider_probe" as const,
      });
    })
    .filter((model) => model.id.length > 0);
}

function parseAnthropicModels(provider: string, payload: unknown): ModelDefinition[] {
  return getRecords(payload)
    .map((record) => {
      const id = getModelId(record);
      return applyKnownModelMetadata({
        provider,
        id,
        name: getString(record.display_name) ?? id,
        description: `Anthropic model${record.created_at ? ` (${String(record.created_at)})` : ""}`,
        ...getContextWindowField(record),
        source: "provider_probe" as const,
      });
    })
    .filter((model) => model.id.length > 0);
}

function parseGoogleModels(provider: string, payload: unknown): ModelDefinition[] {
  return getRecords(payload)
    .filter((record) => {
      const methods = Array.isArray(record.supportedGenerationMethods)
        ? record.supportedGenerationMethods
        : [];
      return methods.length === 0 || methods.includes("generateContent");
    })
    .map((record) => {
      const rawName = getString(record.name) ?? "";
      const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
      return applyKnownModelMetadata({
        provider,
        id,
        name: getString(record.displayName) ?? id,
        description: getString(record.description) ?? "Model returned by Google Gemini",
        ...getContextWindowField(record),
        source: "provider_probe" as const,
      });
    })
    .filter((model) => model.id.length > 0);
}

function parseOpenRouterModels(provider: string, payload: unknown): ModelDefinition[] {
  return getRecords(payload)
    .filter(isTextModel)
    .map((record) => {
      const id = getModelId(record);
      return applyKnownModelMetadata({
        provider,
        id,
        name: getString(record.name) ?? id,
        description: getString(record.description) ?? "Model returned by OpenRouter",
        ...getContextWindowField(record),
        source: "provider_probe" as const,
      });
    })
    .filter((model) => model.id.length > 0);
}

function getRecords(payload: unknown): GenericModelRecord[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [];
  }

  const candidate = payload as Record<string, unknown>;
  const records = Array.isArray(candidate.data)
    ? candidate.data
    : Array.isArray(candidate.models)
      ? candidate.models
      : Array.isArray(candidate.output)
        ? candidate.output
        : isRecord(candidate.output) && Array.isArray(candidate.output.models)
          ? candidate.output.models
        : [];

  return records.filter(
    (record): record is GenericModelRecord =>
      typeof record === "object" && record !== null && !Array.isArray(record),
  );
}

function getModelId(record: GenericModelRecord): string {
  return getString(record.id) ?? getString(record.model) ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextModel(record: GenericModelRecord): boolean {
  const id = `${getString(record.id) ?? ""} ${getString(record.name) ?? ""}`.toLowerCase();
  const excludedTerms = [
    "embedding",
    "moderation",
    "whisper",
    "dall-e",
    "text-to-speech",
    "tts",
    "image-generation",
    "image generation",
    "realtime",
  ];
  if (excludedTerms.some((term) => id.includes(term))) {
    return false;
  }

  const outputModalities = record.architecture?.output_modalities;
  return !Array.isArray(outputModalities) || outputModalities.includes("text");
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getContextWindowField(record: GenericModelRecord): { contextWindow?: number } {
  const candidates = [
    record.context_length,
    record.contextWindow,
    record.context_window,
    record.input_token_limit,
    record.maxInputTokens,
    record.top_provider?.context_length,
  ];
  const contextWindow = candidates.find(
    (value): value is number =>
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0,
  );
  return contextWindow ? { contextWindow } : {};
}

function getProviderError(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "request failed";
  }

  const candidate = payload as Record<string, unknown>;
  const error = candidate.error;
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return typeof candidate.message === "string" ? candidate.message : "request failed";
}
