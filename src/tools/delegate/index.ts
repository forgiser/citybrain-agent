import type { AuthStorage } from "../../auth/auth-storage.js";
import { AgentLoop, type AgentEvent } from "../../agent/agent-loop.js";
import type { SubagentTraceStep } from "../../agent/agent-status.js";
import type { ChatToolDefinition, ModelUsage, StreamChatOptions } from "../../models/model-chat.js";
import { ModelRuntime } from "../../models/model-runtime.js";
import { SessionManager } from "../../session/session-manager.js";
import type { QgisRuntimeInfo } from "../../integrations/qgis/qgis-runtime.js";
import { createDescribeQgisAlgorithmTool } from "../describe-qgis-algorithm/index.js";
import { createListFilesTool } from "../list-files/index.js";
import { createListQgisAlgorithmsTool } from "../list-qgis-algorithms/index.js";
import { createReadFileTool } from "../read-file/index.js";
import { ContextUsageLogger } from "../../context/context-usage-log.js";
import { ToolExecutionLogger } from "../core/observability/tool-execution-log.js";
import type { ToolCallContext } from "../core/contracts/tool-context.js";
import { ToolRegistry } from "../core/execution/tool-registry.js";
import type { SandboxPolicy } from "../../workspace/sandbox-policy.js";
import type { HumanInteractionBroker } from "../../harness/human-interaction.js";
import type { ContextBuildInputs } from "../../context/context-types.js";

/**
 * Dependencies the delegate tool needs to spawn an isolated subagent loop. The
 * key isolation guarantee: the subagent gets a FRESH, in-memory SessionManager
 * (zero conversation history and no user-visible transcript) and a tool set
 * that excludes the delegate tool itself — both preventing context bleed,
 * conversation-list pollution, and unbounded delegation.
 */
export interface SubagentToolDeps {
  modelRuntime: ModelRuntime;
  authStorage: AuthStorage;
  getCwd: () => string;
  getParentSession?: () => SessionManager;
  getSandboxPolicy?: () => SandboxPolicy;
  /** Shared QGIS runtime getter — deferred so a /qgis runtime change applies to new subagents too. */
  getQgisRuntime: () => QgisRuntimeInfo | undefined;
  toolLogger?: ToolExecutionLogger;
  contextLogger?: ContextUsageLogger;
  humanInteractionBroker?: HumanInteractionBroker;
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
      "brief it completely in `prompt` (goal, known facts, expected report). " +
      "Choose data-explorer for read-only data investigation or spatial-planner " +
      "for a read-only geospatial plan. Neither type can write files, run QGIS " +
      "processing, alter the map, or delegate further. It returns one result.",
    parameters: {
      type: "object",
      properties: {
        subagent_type: {
          type: "string",
          enum: ["data-explorer", "spatial-planner"],
          description: "Built-in specialist: data-explorer or spatial-planner.",
        },
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
      required: ["subagent_type", "prompt"],
      additionalProperties: false,
    },
  },
};

/**
 * Create the delegate tool. It spawns a fresh AgentLoop bound to a brand-new
 * transient SessionManager (empty history, no JSONL transcript) and a child
 * child ToolRegistry contains only the selected specialist's read-only tools and
 * never includes delegate, so subagents cannot recurse.
 */
export type SubagentType = "data-explorer" | "spatial-planner";

const PROFILES: Record<SubagentType, Pick<ContextBuildInputs,
  "rolePrompt" | "missionPrompt" | "workingDisciplinePrompt" | "toolSemanticsPrompt">> = {
  "data-explorer": {
    rolePrompt: "You are CityBrain's data-explorer subagent. Investigate workspace data and report evidence to the parent agent.",
    missionPrompt: "Identify relevant datasets, formats, available metadata, schemas, CRS and quality signals only when supported by readable evidence. Distinguish observations from inferences. Binary raster/vector formats cannot be inspected through read_file as text; use existing readable metadata or report the limitation.",
    workingDisciplinePrompt: "Read-only investigation. Do not create, edit, delete, process, or visualize data. Do not claim to have inspected binary content or a map. Return concise findings with source paths and explicit uncertainties.",
    toolSemanticsPrompt: "Available tools: list_files to discover paths; read_file to inspect text files and readable profiles. No file-write, QGIS processing, map, background-task, or delegation tools are available.",
  },
  "spatial-planner": {
    rolePrompt: "You are CityBrain's spatial-planner subagent. Design a verifiable geospatial analysis plan for the parent agent to execute.",
    missionPrompt: "Given the supplied goal and available evidence, propose ordered inputs, CRS handling, QGIS algorithms and parameters, expected outputs, validation checks, and important risks. Check actual algorithm definitions before recommending exact parameters.",
    workingDisciplinePrompt: "Planning only: do not run processing, create or edit files, change the map, or imply the plan has executed. Mark missing inputs and unverified assumptions clearly; return an actionable plan to the parent agent.",
    toolSemanticsPrompt: "Available tools: list_files and read_file for readable workspace context; list_qgis_algorithms and describe_qgis_algorithm for read-only algorithm discovery. No QGIS run, file-write, map, background-task, or delegation tools are available.",
  },
};

export function createSubagentRegistry(type: SubagentType, deps: SubagentToolDeps): ToolRegistry {
  if (type !== "data-explorer" && type !== "spatial-planner") {
    throw new Error(`Unsupported subagent type: ${String(type)}`);
  }
  const registry = new ToolRegistry({
    logger: deps.toolLogger,
    sandbox: deps.getSandboxPolicy,
    permission: { humanInteractionBroker: deps.humanInteractionBroker },
  });
  registry.registerMany([
    createReadFileTool({ getCwd: deps.getCwd }),
    createListFilesTool({ getCwd: deps.getCwd }),
  ]);
  if (type === "spatial-planner") {
    registry.registerMany([
      createListQgisAlgorithmsTool(deps.getQgisRuntime),
      createDescribeQgisAlgorithmTool(deps.getQgisRuntime),
    ]);
  }
  return registry;
}
export function createSubagentTool(
  deps: SubagentToolDeps,
): {
  definition: ChatToolDefinition;
  handler: (args: unknown, context?: ToolCallContext) => Promise<string>;
  isConcurrencySafe: (args: unknown) => boolean;
} {
  return {
    definition: subagentToolDefinition,
    handler: async (args, context) => {
      const raw = (args ?? {}) as { subagent_type?: unknown; description?: unknown; prompt?: unknown };
      const type = raw.subagent_type;
      if (type !== "data-explorer" && type !== "spatial-planner") {
        throw new Error("delegate requires subagent_type: data-explorer or spatial-planner.");
      }
      const prompt =
        typeof raw.prompt === "string" && raw.prompt.trim() ? raw.prompt.trim() : "";
      if (!prompt) {
        throw new Error("delegate requires a non-empty prompt.");
      }

      const description =
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : type;
      const emit = context?.emitAgentStatus;
      const parentSession = deps.getParentSession?.();
      const trace: SubagentTraceStep[] = [];
      let traceChars = 0;
      const appendTrace = (step: SubagentTraceStep): void => {
        const bounded = {
          ...step,
          ...(step.delta ? { delta: step.delta.slice(0, 8_000) } : {}),
          ...(step.argumentsText ? { argumentsText: step.argumentsText.slice(0, 12_000) } : {}),
          ...(step.result ? { result: step.result.slice(0, 12_000) } : {}),
        };
        context?.emitSubagentEvent?.(bounded);
        if (trace.length >= 120 || traceChars >= 80_000) return;
        const previous = trace.at(-1);
        if (bounded.delta && previous?.type === bounded.type && previous.delta !== undefined) {
          previous.delta = `${previous.delta}${bounded.delta}`.slice(0, 12_000);
        } else {
          trace.push(bounded);
        }
        traceChars += JSON.stringify(bounded).length;
      };
      const saveTrace = (status: "completed" | "failed"): void => {
        if (!parentSession || !context?.toolCallId) return;
        try {
          parentSession.appendSubagentTrace({
            parentToolCallId: context.toolCallId,
            subagentType: type,
            label: description,
            status,
            steps: trace,
          });
        } catch {
          // A trace persistence failure must not invalidate completed work.
        }
      };
      emit?.({ agent: description, status: "running" });

      const subSession = SessionManager.createTransient(deps.getCwd());
      const childTools = createSubagentRegistry(type, deps);
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
            ...PROFILES[type],
            qgisRuntimeSummary: runtime
              ? `${runtime.version} (${runtime.executablePath})`
              : undefined,
          };
        },
        deps.humanInteractionBroker,
      );

      // Surface the subagent's token usage up as it streams, so the UI can
      // show a live cost line. The sub-loop's onUsage fires per model call.
      let usage: ModelUsage | undefined;
      const streamOptions: StreamChatOptions = {
        ...deps.options,
        signal: context?.signal ?? deps.options?.signal,
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
          const step = toTraceStep(value);
          if (step) appendTrace(step);
        }

        saveTrace("completed");
        emit?.({ agent: description, status: "completed", usage });
        return `[${type}: ${description}] completed.\n${finalResponse}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        saveTrace("failed");
        emit?.({ agent: description, status: "failed", usage, error: message });
        throw error;
      }
    },
    // Nested agent runs are heavy and share model/auth state; run exclusively.
    isConcurrencySafe: () => false,
  };
}

function toTraceStep(event: AgentEvent): SubagentTraceStep | undefined {
  if (event.type === "text" || event.type === "thinking") {
    return { type: event.type, delta: event.delta };
  }
  if (event.type === "tool_started") {
    return {
      type: event.type,
      name: event.name,
      toolCallId: event.toolCallId,
      argumentsText: event.argumentsText,
      activityDescription: event.activityDescription,
      toolUseSummary: event.toolUseSummary,
    };
  }
  if (event.type === "tool_result") {
    return {
      type: event.type,
      name: event.name,
      toolCallId: event.toolCallId,
      argumentsText: event.argumentsText,
      result: event.result,
      ok: event.ok,
      status: event.status,
    };
  }
  return undefined;
}
