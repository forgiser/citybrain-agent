import type { AgentStatusUpdate } from "../agent/agent-status.js";
import type { ChatToolDefinition } from "../models/model-chat.js";

/** Per-call context handed to a tool handler so it can stream live events up. */
export interface ToolCallContext {
  /** Emit a subagent status update to the parent AgentLoop (and onward to UI). */
  emitAgentStatus?: (update: AgentStatusUpdate) => void;
}

export type ToolHandler = (args: unknown, context?: ToolCallContext) => Promise<string>;

export interface ToolRegistrationOptions {
  /**
   * Whether this tool may run in parallel with other concurrency-safe tools
   * for the given parsed arguments. Omit (or return false) for tools with
   * side effects or ordering dependencies — they execute exclusively.
   */
  isConcurrencySafe?: (args: unknown) => boolean;
}

export interface ToolExecutionOutcome {
  ok: boolean;
  content: string;
}

interface RegisteredTool {
  definition: ChatToolDefinition;
  handler: ToolHandler;
  isConcurrencySafe?: (args: unknown) => boolean;
}

/**
 * Minimal tool registry shared by the Agent Loop. Handlers own their own
 * validation and throw Error on bad input; execute() converts that into the
 * tool-error result sent back to the model.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(
    definition: ChatToolDefinition,
    handler: ToolHandler,
    options: ToolRegistrationOptions = {},
  ): void {
    this.tools.set(definition.function.name, {
      definition,
      handler,
      isConcurrencySafe: options.isConcurrencySafe,
    });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  definitions(): ChatToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  /**
   * Concurrency verdict for a tool call. Undeclared, unknown, or unparseable
   * calls are treated as NOT concurrency-safe (exclusive) — the conservative
   * default. Mirrors Claude Code's StreamingToolExecutor.isConcurrencySafe.
   */
  isConcurrencySafe(name: string, argumentsText: string): boolean {
    const tool = this.tools.get(name);
    if (!tool?.isConcurrencySafe) return false;
    let args: unknown;
    try {
      args = parseToolArguments(argumentsText);
    } catch {
      return false;
    }
    try {
      return Boolean(tool.isConcurrencySafe(args));
    } catch {
      return false;
    }
  }

  async execute(
    name: string,
    argumentsText: string,
    context?: ToolCallContext,
  ): Promise<ToolExecutionOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, content: `Tool error: unknown tool "${name}".` };
    }

    let args: unknown;
    try {
      args = parseToolArguments(argumentsText);
    } catch {
      return { ok: false, content: `Tool error: invalid JSON arguments for ${name}.` };
    }

    try {
      return { ok: true, content: await tool.handler(args, context) };
    } catch (error) {
      return {
        ok: false,
        content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

function parseToolArguments(argumentsText: string): unknown {
  const repaired = repairWindowsPathStringLiterals(argumentsText);
  if (repaired !== argumentsText) {
    try {
      return JSON.parse(repaired) as unknown;
    } catch {
      // Fall back to the original parse so ordinary JSON errors keep their normal path.
    }
  }
  return JSON.parse(argumentsText) as unknown;
}

function repairWindowsPathStringLiterals(jsonText: string): string {
  let repaired = "";
  let index = 0;

  while (index < jsonText.length) {
    const char = jsonText[index];
    if (char !== "\"") {
      repaired += char;
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    let content = "";
    while (index < jsonText.length) {
      const current = jsonText[index]!;
      if (current === "\"" && !isEscapedQuote(jsonText, index)) {
        break;
      }
      content += current;
      index += 1;
    }

    if (index >= jsonText.length) {
      repaired += jsonText.slice(start);
      break;
    }

    repaired += "\"" + repairWindowsPathLiteralContent(content) + "\"";
    index += 1;
  }

  return repaired;
}

function repairWindowsPathLiteralContent(content: string): string {
  if (!/[A-Za-z]:(?:\\|\/)/u.test(content) && !content.includes("\\\\")) {
    return content;
  }

  let repaired = "";
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (char !== "\\") {
      repaired += char;
      continue;
    }

    let end = index + 1;
    while (end < content.length && content[end] === "\\") end += 1;
    const run = content.slice(index, end);
    repaired += run.length === 1 ? "\\\\" : run;
    index = end - 1;
  }

  return repaired;
}

function isEscapedQuote(text: string, quoteIndex: number): boolean {
  let slashCount = 0;
  for (let index = quoteIndex - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}
