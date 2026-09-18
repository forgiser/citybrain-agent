import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { ApiKeyCredential } from "../auth/auth-storage.js";
import type { ModelDefinition } from "./model-catalog.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export type ThinkingLevel = "off" | "high" | "max";

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatDelta {
  type: "text" | "thinking" | "tool_call";
  delta: string;
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
  };
}

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface StreamChatOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  tools?: ChatToolDefinition[];
  onUsage?: (usage: ModelUsage) => void;
}

interface ChatProvider {
  provider: string;
  buildRequest(
    model: ModelDefinition,
    credential: ApiKeyCredential,
    messages: ChatMessage[],
    options: StreamChatOptions,
  ): {
    url: string;
    init: RequestInit;
  };
  readDeltas(event: unknown): ChatDelta[];
  readUsage?(event: unknown, current: ModelUsage | undefined): ModelUsage | undefined;
  isDone?(event: unknown): boolean;
}

const openAiCompatibleProviders: Record<
  string,
  { baseUrl: string; errorName: string }
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    errorName: "OpenAI",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    errorName: "DeepSeek",
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    errorName: "Qwen",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    errorName: "OpenRouter",
  },
};

export async function* streamModelChat(
  model: ModelDefinition,
  credential: ApiKeyCredential,
  messages: ChatMessage[],
  options: StreamChatOptions = {},
): AsyncGenerator<ChatDelta> {
  const compatible = openAiCompatibleProviders[model.provider];
  if (compatible) {
    yield* streamOpenAiCompatible(model, credential, messages, options, compatible);
    return;
  }

  const provider = createLegacyChatProvider(model.provider);
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = provider.buildRequest(model, credential, messages, options);
  const response = await fetchImpl(request.url, request.init);

  if (!response.ok) {
    throw new Error(`${provider.provider} ${response.status}: ${await getErrorMessage(response)}`);
  }
  if (!response.body) {
    throw new Error(`${provider.provider} returned an empty response body`);
  }

  let usage: ModelUsage | undefined;
  for await (const event of readServerSentEvents(response.body)) {
    if (provider.isDone?.(event)) {
      if (usage) options.onUsage?.(usage);
      return;
    }
    usage = provider.readUsage?.(event, usage) ?? usage;
    for (const delta of provider.readDeltas(event)) {
      if (delta.delta || delta.type === "tool_call") {
        yield delta;
      }
    }
  }
  if (usage) {
    options.onUsage?.(usage);
  }
}

async function* streamOpenAiCompatible(
  model: ModelDefinition,
  credential: ApiKeyCredential,
  messages: ChatMessage[],
  options: StreamChatOptions,
  provider: { baseUrl: string; errorName: string },
): AsyncGenerator<ChatDelta> {
  const client = new OpenAI({
    apiKey: credential.key,
    baseURL: provider.baseUrl,
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });

  try {
    let usage: ModelUsage | undefined;
    const requestBody: Record<string, unknown> = {
      model: model.id,
      messages: messages.map(toOpenAiMessage),
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_tokens: options.maxTokens ?? 4096,
      ...(options.tools?.length ? { tools: options.tools, tool_choice: "auto" } : {}),
    };
    applyOpenAiCompatibleThinking(requestBody, model, options, provider.errorName);

    const stream = await client.chat.completions.create(
      requestBody as unknown as ChatCompletionCreateParamsStreaming,
      options.signal ? { signal: options.signal } : undefined,
    );

    for await (const chunk of stream) {
      usage = readOpenAiUsage(chunk) ?? usage;
      const choiceUsage = chunk.choices[0]
        ? readOpenAiUsage((chunk.choices[0] as unknown as { usage?: unknown }).usage)
        : undefined;
      usage = choiceUsage ?? usage;
      const rawDelta = chunk.choices[0]?.delta as unknown as Record<string, unknown> | undefined;
      const thinking = readReasoningText(
        rawDelta?.reasoning_content ?? rawDelta?.reasoning ?? rawDelta?.reasoning_details,
      );
      if (thinking) {
        yield { type: "thinking", delta: thinking };
      }
      const text = rawDelta?.content;
      if (typeof text === "string" && text.length > 0) {
        yield { type: "text", delta: text };
      }
      const toolCalls = rawDelta?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const rawToolCall of toolCalls) {
          if (!isRecord(rawToolCall) || typeof rawToolCall.index !== "number") {
            continue;
          }
          const functionCall = isRecord(rawToolCall.function)
            ? rawToolCall.function
            : undefined;
          const name = typeof functionCall?.name === "string"
            ? functionCall.name
            : undefined;
          const argumentsText = typeof functionCall?.arguments === "string"
            ? functionCall.arguments
            : "";
          yield {
            type: "tool_call",
            delta: argumentsText,
            toolCall: {
              index: rawToolCall.index,
              id: typeof rawToolCall.id === "string" ? rawToolCall.id : undefined,
              name,
            },
          };
        }
      }
    }
    if (usage) {
      options.onUsage?.(usage);
    }
  } catch (error) {
    throw formatProviderError(provider.errorName, error);
  }
}

function toOpenAiMessage(message: ChatMessage): ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId ?? "",
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      })),
    };
  }
  return {
    role: message.role as "system" | "user" | "assistant",
    content: message.content,
  };
}

function toAnthropicMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      }],
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...message.toolCalls.map((toolCall) => ({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: parseJsonObject(toolCall.arguments),
        })),
      ],
    };
  }

  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  };
}

function toGoogleMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      parts: [{
        functionResponse: {
          name: message.toolName ?? "read_file",
          response: { content: message.content },
        },
      }],
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "model",
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...message.toolCalls.map((toolCall) => ({
          functionCall: {
            name: toolCall.name,
            args: parseJsonObject(toolCall.arguments),
          },
        })),
      ],
    };
  }

  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function createLegacyChatProvider(providerId: string): ChatProvider {
  if (providerId === "anthropic") {
    return {
      provider: "Anthropic",
      buildRequest: (model, credential, messages, options) => {
        const system = messages.find((message) => message.role === "system")?.content;
        const conversation = messages
          .filter((message) => message.role !== "system")
          .map(toAnthropicMessage);

        const thinkingLevel = options.thinkingLevel ?? "off";
        const thinkingBudget = getThinkingBudget(thinkingLevel);
        const body: Record<string, unknown> = {
          model: model.id,
          max_tokens: thinkingLevel === "off"
            ? options.maxTokens ?? 4096
            : Math.max(options.maxTokens ?? 4096, thinkingBudget + 4096),
          stream: true,
          ...(system ? { system } : {}),
          messages: conversation,
          ...(options.tools?.length
            ? {
                tools: options.tools.map((tool) => ({
                  name: tool.function.name,
                  description: tool.function.description,
                  input_schema: tool.function.parameters,
                })),
              }
            : {}),
        };
        if (thinkingLevel !== "off") {
          body.thinking = {
            type: "enabled",
            budget_tokens: thinkingBudget,
          };
        }

        return {
          url: "https://api.anthropic.com/v1/messages",
          init: {
            method: "POST",
            headers: {
              "x-api-key": credential.key,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: options.signal,
          },
        };
      },
      readDeltas: (event) => {
        if (!isRecord(event)) {
          return [];
        }
        if (event.type === "content_block_start" && isRecord(event.content_block)) {
          const block = event.content_block;
          if (
            block.type === "tool_use" &&
            typeof event.index === "number" &&
            typeof block.name === "string"
          ) {
            return [{
              type: "tool_call",
              delta: "",
              toolCall: {
                index: event.index,
                id: typeof block.id === "string" ? block.id : undefined,
                name: block.name,
              },
            }];
          }
          return [];
        }
        if (event.type !== "content_block_delta") {
          return [];
        }
        const delta = event.delta;
        if (!isRecord(delta)) return [];
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          return [{ type: "thinking", delta: delta.thinking }];
        }
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          return [{ type: "text", delta: delta.text }];
        }
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          return [{
            type: "tool_call",
            delta: delta.partial_json,
            toolCall: {
              index: typeof event.index === "number" ? event.index : 0,
            },
          }];
        }
        return [];
      },
      readUsage: readAnthropicUsage,
    };
  }

  if (providerId === "google") {
    return {
      provider: "Google Gemini",
      buildRequest: (model, credential, messages, options) => {
        const system = messages.find((message) => message.role === "system")?.content;
        const conversation = messages
          .filter((message) => message.role !== "system")
          .map(toGoogleMessage);

        const thinkingLevel = options.thinkingLevel ?? "off";
        const thinkingBudget = getThinkingBudget(thinkingLevel);
        const generationConfig: Record<string, unknown> = {
          maxOutputTokens: options.maxTokens ?? 4096,
          thinkingConfig: thinkingLevel === "off"
            ? { thinkingBudget: 0 }
            : {
                includeThoughts: true,
                thinkingBudget,
              },
        };

        return {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,
          init: {
            method: "POST",
            headers: {
              "x-goog-api-key": credential.key,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...(system
                ? {
                    systemInstruction: {
                      parts: [{ text: system }],
                    },
                  }
                : {}),
              contents: conversation,
              generationConfig,
              ...(options.tools?.length
                ? {
                    tools: [{
                      functionDeclarations: options.tools.map((tool) => ({
                        name: tool.function.name,
                        description: tool.function.description,
                        parameters: tool.function.parameters,
                      })),
                    }],
                  }
                : {}),
            }),
            signal: options.signal,
          },
        };
      },
      readDeltas: (event) => {
        if (!isRecord(event) || !Array.isArray(event.candidates)) {
          return [];
        }
        const candidate = event.candidates[0];
        if (!isRecord(candidate) || !isRecord(candidate.content)) {
          return [];
        }
        const parts = candidate.content.parts;
        if (!Array.isArray(parts)) {
          return [];
        }
        return parts.filter(isRecord).flatMap((part, index): ChatDelta[] => {
          if (isRecord(part.functionCall) && typeof part.functionCall.name === "string") {
            return [{
              type: "tool_call",
              delta: JSON.stringify(
                isRecord(part.functionCall.args) ? part.functionCall.args : {},
              ),
              toolCall: {
                index,
                name: part.functionCall.name,
              },
            } satisfies ChatDelta];
          }
          if (typeof part.text !== "string" || !part.text) return [];
          return [
            {
              type: part.thought === true || part.isThought === true ? "thinking" : "text",
              delta: part.text,
            } satisfies ChatDelta,
          ];
        });
      },
      readUsage: readGoogleUsage,
    };
  }

  throw new Error(`Streaming chat is not configured for provider: ${providerId}`);
}

function formatProviderError(provider: string, error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return error;
  }

  const status =
    isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const statusSuffix = status !== undefined && !message.startsWith(`${status}`)
    ? ` ${status}`
    : "";

  return new Error(`${provider}${statusSuffix}: ${message}`, { cause: error });
}

function getThinkingBudget(level: ThinkingLevel): number {
  return level === "max" ? 32_768 : 16_384;
}

function applyOpenAiCompatibleThinking(
  body: Record<string, unknown>,
  model: ModelDefinition,
  options: StreamChatOptions,
  providerName: string,
): void {
  const level = options.thinkingLevel ?? "off";
  const enabled = level !== "off";
  const effort = enabled ? "high" : "none";

  if (providerName === "DeepSeek") {
    body.thinking = { type: enabled ? "enabled" : "disabled" };
    return;
  }

  if (providerName === "Qwen") {
    body.enable_thinking = enabled;
    if (enabled) {
      body.thinking_budget = getThinkingBudget(level);
    }
    return;
  }

  if (providerName === "OpenRouter") {
    body.reasoning = { effort };
    return;
  }

  if (
    providerName === "OpenAI" &&
    !/^(o\d|gpt-5|.*reason)/iu.test(model.id)
  ) {
    return;
  }

  body.reasoning_effort = effort;
}

function readReasoningText(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (!Array.isArray(value)) return undefined;

  const text = value
    .filter(isRecord)
    .map((part) => {
      if (typeof part.text === "string") return part.text;
      if (typeof part.reasoning === "string") return part.reasoning;
      return "";
    })
    .join("");
  return text || undefined;
}

function readOpenAiUsage(value: unknown): ModelUsage | undefined {
  const rawUsage = isRecord(value) && isRecord(value.usage) ? value.usage : value;
  if (!isRecord(rawUsage)) {
    return undefined;
  }

  const promptTokens = getNumber(rawUsage.prompt_tokens);
  const completionTokens = getNumber(rawUsage.completion_tokens);
  const promptDetails = isRecord(rawUsage.prompt_tokens_details)
    ? rawUsage.prompt_tokens_details
    : undefined;
  const cacheRead =
    getNumber(promptDetails?.cached_tokens) ||
    getNumber(rawUsage.prompt_cache_hit_tokens) ||
    getNumber(rawUsage.cached_tokens);
  const cacheWrite = getNumber(promptDetails?.cache_write_tokens);
  const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
  const totalTokens = getNumber(rawUsage.total_tokens) || input + completionTokens + cacheRead + cacheWrite;

  if (totalTokens <= 0) {
    return undefined;
  }
  return {
    input,
    output: completionTokens,
    cacheRead,
    cacheWrite,
    totalTokens,
  };
}

function readAnthropicUsage(
  event: unknown,
  current: ModelUsage | undefined,
): ModelUsage | undefined {
  if (!isRecord(event)) {
    return current;
  }

  const rawUsage =
    event.type === "message_start" && isRecord(event.message) && isRecord(event.message.usage)
      ? event.message.usage
      : isRecord(event.usage)
        ? event.usage
        : undefined;
  if (!rawUsage) {
    return current;
  }

  const cacheRead = getNumber(rawUsage.cache_read_input_tokens);
  const cacheWrite = getNumber(rawUsage.cache_creation_input_tokens);
  const rawInput = getNumber(rawUsage.input_tokens);
  const output = getNumber(rawUsage.output_tokens) || current?.output || 0;
  const input = Math.max(0, rawInput - cacheRead - cacheWrite);
  const totalTokens = input + output + cacheRead + cacheWrite;
  if (totalTokens <= 0) {
    return current;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
  };
}

function readGoogleUsage(event: unknown): ModelUsage | undefined {
  if (!isRecord(event) || !isRecord(event.usageMetadata)) {
    return undefined;
  }

  const usage = event.usageMetadata;
  const promptTokens = getNumber(usage.promptTokenCount);
  const output =
    getNumber(usage.candidatesTokenCount) ||
    getNumber(usage.candidateTokenCount);
  const cacheRead = getNumber(usage.cachedContentTokenCount);
  // Gemini's promptTokenCount already includes cached content. Normalize the
  // same way as the OpenAI-compatible and Anthropic adapters so promptTokens
  // does not double-count cacheRead.
  const input = Math.max(0, promptTokens - cacheRead);
  const totalTokens =
    getNumber(usage.totalTokenCount) || input + output + cacheRead;

  if (totalTokens <= 0) {
    return undefined;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens,
  };
}

function getNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

async function getErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return response.statusText || "request failed";
  }

  try {
    const payload: unknown = JSON.parse(text);
    if (isRecord(payload)) {
      const error = payload.error;
      if (typeof error === "string") {
        return error;
      }
      if (isRecord(error) && typeof error.message === "string") {
        return error.message;
      }
      if (typeof payload.message === "string") {
        return payload.message;
      }
    }
  } catch {
    // Fall through to the provider's plain-text response.
  }

  return text.slice(0, 500);
}

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          const event = parseEvent(dataLines);
          dataLines = [];
          if (event !== undefined) {
            yield event;
          }
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }

    if (buffer.startsWith("data:")) {
      dataLines.push(buffer.slice(5).trimStart());
    }
    const event = parseEvent(dataLines);
    if (event !== undefined) {
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(dataLines: string[]): unknown {
  const data = dataLines.join("\n").trim();
  if (!data) {
    return undefined;
  }
  if (data === "[DONE]") {
    return data;
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
