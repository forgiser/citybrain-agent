import type { AuthStorage } from "../auth/auth-storage.js";
import { AgentLoop } from "../agent/agent-loop.js";
import type { ChatToolDefinition, ModelUsage, StreamChatOptions } from "../models/model-chat.js";
import { ModelRuntime } from "../models/model-runtime.js";
import { SessionManager } from "../session/session-manager.js";
import type { QgisRuntimeInfo } from "../qgis/qgis-runtime.js";
import { createQgisTools, type QgisTool } from "../qgis/qgis-tools.js";
import { executeReadFile, readFileToolDefinition } from "./read-file.js";
import { executeListFiles, listFilesToolDefinition } from "./list-files.js";
import { ContextUsageLogger } from "../context/context-usage-log.js";
import { ToolExecutionLogger } from "./tool-execution-log.js";
import type { ToolCallContext } from "./tool-registry.js";
import { ToolRegistry } from "./tool-registry.js";

/**
 * Dependencies the delegate tool needs to spawn an isolated subagent loop. The
 * key isolation guarantee: the subagent gets a FRESH, empty SessionManager
 * (zero conversation history, per Claude Code's "fresh agent starts with zero
 * context") and a tool set that excludes the delegate tool itself — both
 * preventing context bleed and unbounded delegation.
 */
export interface SubagentToolDeps {
  modelRuntime: ModelRuntime;
  authStorage: AuthStorage;
  getCwd: () => string;
  /** Shared QGIS runtime getter — deferred so a /qgis runtime change applies to new subagents too. */
  getQgisRuntime: () => QgisRuntimeInfo | undefined;
  toolLogger?: ToolExecutionLogger;
  contextLogger?: ContextUsageLogger;
  /** Optional run options forwarded to the subagent loop's stream (thinkingLevel, etc). */
  options?: StreamChatOptions;
}

export const subagentToolDefinition: ChatToolDefinition = {
  type: "function",
  function: {
    name: "delegate",
    description:
      "Delegate a self-contained sub-task to a subagent running in an isolated " +
      "context. The subagent cannot see this conversation's history; you must " +
      "brief it completely in `prompt` (what you're trying to do, what's already " +
      "known, what to report). It has access to QGIS tools, list_files, and read_file, and " +
      "cannot delegate further. It returns a single text result when done.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "A short (3-5 word) description of the sub-task.",
        },
        prompt: {
          type: "string",
          description:
            "Self-contained instructions for the subagent, as if to a colleague " +
            "who just walked in: the goal, what's already tried/known, what to " +
            "produce. If you need a short answer, say so.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
};

/**
 * Create the delegate tool. It spawns a fresh AgentLoop bound to a brand-new
 * SessionManager (empty history) and a child ToolRegistry whose tools come
 * from QGIS + read_file — the delegate tool is NOT included, so a subagent
 * cannot recurse into more subagents.
 */
export function createSubagentTool(
  deps: SubagentToolDeps,
): {
  definition: ChatToolDefinition;
  handler: (args: unknown, context?: ToolCallContext) => Promise<string>;
  isConcurrencySafe: (args: unknown) => boolean;
} {
  const buildChildTools = (runtime: () => QgisRuntimeInfo | undefined): ToolRegistry => {
    const registry = new ToolRegistry({ logger: deps.toolLogger });
    registry.register(
      readFileToolDefinition,
      (args, toolContext) => executeReadFile(args, deps.getCwd(), toolContext),
      { isConcurrencySafe: () => true },
    );
    registry.register(
      listFilesToolDefinition,
      (args) => executeListFiles(args, deps.getCwd()),
      { isConcurrencySafe: () => true },
    );
    for (const tool of createQgisTools(runtime)) {
      registry.register(tool.definition, tool.handler, {
        isConcurrencySafe: tool.isConcurrencySafe,
      });
    }
    return registry;
  };

  return {
    definition: subagentToolDefinition,
    handler: async (args, context) => {
      const raw = (args ?? {}) as { description?: unknown; prompt?: unknown };
      const prompt =
        typeof raw.prompt === "string" && raw.prompt.trim() ? raw.prompt.trim() : "";
      if (!prompt) {
        throw new Error("delegate requires a non-empty prompt.");
      }

      const description =
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : "delegated task";
      const emit = context?.emitAgentStatus;
      emit?.({ agent: description, status: "running" });

      const subSession = SessionManager.create(deps.getCwd());
      const childTools = buildChildTools(deps.getQgisRuntime);
      const subLoop = new AgentLoop(
        deps.modelRuntime,
        deps.authStorage,
        subSession,
        childTools,
        deps.toolLogger,
        deps.contextLogger,
        undefined,
        () => {
          const runtime = deps.getQgisRuntime();
          return {
            qgisRuntimeSummary: runtime
              ? `${runtime.version} (${runtime.executablePath})`
              : undefined,
            artifactSummary: formatArtifactSummary(childTools.artifacts.snapshot()),
          };
        },
      );

      // Surface the subagent's token usage up as it streams, so the UI can
      // show a live cost line. The sub-loop's onUsage fires per model call.
      let usage: ModelUsage | undefined;
      const streamOptions: StreamChatOptions = {
        ...deps.options,
        onUsage: (nextUsage) => {
          usage = nextUsage;
          deps.options?.onUsage?.(nextUsage);
          emit?.({ agent: description, status: "running", usage });
        },
      };

      try {
        // Run the subagent to completion, discarding its event stream. Any tool
        // events inside the sub-loop stay inside it — we only surface the final
        // response. This is the "don't peek at the transcript" discipline.
        const iterator = subLoop.run(prompt, streamOptions);
        let finalResponse = "";
        while (true) {
          const { value, done } = await iterator.next();
          if (done) {
            finalResponse = String(value ?? "");
            break;
          }
          // value is an AgentEvent; intentionally dropped to keep isolation.
        }

        emit?.({ agent: description, status: "completed", usage });
        return `[${description}] completed.\n${finalResponse}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit?.({ agent: description, status: "failed", usage, error: message });
        throw error;
      }
    },
    // Nested agent runs are heavy and share model/auth state; run exclusively.
    isConcurrencySafe: () => false,
  };
}

function formatArtifactSummary(
  records: Array<{
    path: string;
    status: string;
    producerTaskId: string;
    error?: string;
  }>,
): string | undefined {
  if (records.length === 0) return undefined;
  return records
    .slice(-20)
    .map((record) => {
      const error = record.error ? `: ${record.error}` : "";
      return `- ${record.status} ${record.path} (task ${record.producerTaskId})${error}`;
    })
    .join("\n");
}
