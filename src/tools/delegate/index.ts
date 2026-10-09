import type { AuthStorage } from "../../auth/auth-storage.js";
import { AgentLoop } from "../../agent/agent-loop.js";
import type { ChatToolDefinition, ModelUsage, StreamChatOptions } from "../../models/model-chat.js";
import { ModelRuntime } from "../../models/model-runtime.js";
import { SessionManager } from "../../session/session-manager.js";
import type { QgisRuntimeInfo } from "../../integrations/qgis/qgis-runtime.js";
import { createDescribeQgisAlgorithmTool } from "../describe-qgis-algorithm/index.js";
import { createEditFileTool } from "../edit-file/index.js";
import { createListFilesTool } from "../list-files/index.js";
import { createListQgisAlgorithmsTool } from "../list-qgis-algorithms/index.js";
import { createReadFileTool } from "../read-file/index.js";
import { createRunQgisAlgorithmTool } from "../run-qgis-algorithm/index.js";
import { createWriteFileTool } from "../write-file/index.js";
import { ContextUsageLogger } from "../../context/context-usage-log.js";
import { ToolExecutionLogger } from "../core/observability/tool-execution-log.js";
import type { ToolCallContext } from "../core/contracts/tool-context.js";
import { ToolRegistry } from "../core/execution/tool-registry.js";
import type { SandboxPolicy } from "../../workspace/sandbox-policy.js";
import type { HumanInteractionBroker } from "../../harness/human-interaction.js";
import type { TaskManager } from "../../task/index.js";
import { createTaskManagementTools } from "../task-management/index.js";

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
  getSandboxPolicy?: () => SandboxPolicy;
  /** Shared QGIS runtime getter — deferred so a /qgis runtime change applies to new subagents too. */
  getQgisRuntime: () => QgisRuntimeInfo | undefined;
  toolLogger?: ToolExecutionLogger;
  contextLogger?: ContextUsageLogger;
  humanInteractionBroker?: HumanInteractionBroker;
  taskManager?: TaskManager;
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
      "known, what to report). It has access to QGIS tools, list_files, read_file, " +
      "write_file, and edit_file. " +
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
    const registry = new ToolRegistry({
      logger: deps.toolLogger,
      sandbox: deps.getSandboxPolicy,
      permission: {
        humanInteractionBroker: deps.humanInteractionBroker,
      },
    });
    registry.registerMany([
      createReadFileTool({ getCwd: deps.getCwd }),
      createListFilesTool({ getCwd: deps.getCwd }),
      createWriteFileTool(),
      createEditFileTool(),
      createListQgisAlgorithmsTool(runtime),
      createDescribeQgisAlgorithmTool(runtime),
      createRunQgisAlgorithmTool(runtime),
    ]);
    if (deps.taskManager) {
      registry.registerMany(createTaskManagementTools(deps.taskManager));
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
            taskSummary: formatTaskSummary(deps.taskManager?.list() ?? []),
          };
        },
        deps.humanInteractionBroker,
        deps.taskManager,
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

function formatTaskSummary(
  tasks: Array<{ id: string; name: string; status: string }>,
): string | undefined {
  if (tasks.length === 0) return undefined;
  return tasks
    .slice(0, 20)
    .map((task) => `- ${task.id} [${task.status}] ${task.name}`)
    .join("\n");
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

function getSinglePath(args: unknown): string | undefined {
  if (
    typeof args === "object" &&
    args !== null &&
    !Array.isArray(args) &&
    typeof (args as { path?: unknown }).path === "string"
  ) {
    const path = (args as { path: string }).path.trim();
    return path || undefined;
  }
  return undefined;
}
