export interface ProviderOption {
  id: string;
  name: string;
  description: string;
}

export const providerOptions: ProviderOption[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI and compatible model APIs",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude model APIs",
  },
  {
    id: "google",
    name: "Google",
    description: "Gemini model APIs",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek model APIs",
  },
  {
    id: "qwen",
    name: "Qwen",
    description: "Qwen model APIs",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Multiple model providers through one API",
  },
];

export function findProviderOption(providerId: string): ProviderOption | undefined {
  const normalized = providerId.trim().toLowerCase();
  return providerOptions.find((provider) => provider.id === normalized);
}

export function filterProviderOptions(prefix: string): ProviderOption[] {
  const normalized = prefix.trim().toLowerCase();
  if (!normalized) {
    return [...providerOptions];
  }

  return providerOptions.filter(
    (provider) =>
      provider.id.startsWith(normalized) ||
      provider.name.toLowerCase().startsWith(normalized),
  );
}
