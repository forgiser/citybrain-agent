import { join } from "node:path";
import { AgentLoop } from "../agent/agent-loop.js";
import { AuthStorage } from "../auth/auth-storage.js";
import { ContextTraceLogger } from "../context/context-trace-log.js";
import { ContextUsageLogger } from "../context/context-usage-log.js";
import { HumanInteractionBroker } from "../harness/human-interaction.js";
import {
  createAgentHostProfile,
  hasHostCapability,
  resolveHostPrompt,
  type AgentHostProfile,
} from "../host/index.js";
import {
  detectQgisRuntime,
  type QgisRuntimeInfo,
} from "../integrations/qgis/qgis-runtime.js";
import type { ThinkingLevel } from "../models/model-chat.js";
import { ModelRuntime } from "../models/model-runtime.js";
import { SessionManager } from "../session/session-manager.js";
import {
  TaskManager,
  isTaskTerminal,
  type TaskSnapshot,
} from "../task/index.js";
import {
  createFileTools,
  createMapTools,
  createQgisTools,
  createSubagentTool,
  createTaskManagementTools,
} from "../tools/index.js";
import { ToolRegistry } from "../tools/core/execution/tool-registry.js";
import { ToolExecutionLogger } from "../tools/core/observability/tool-execution-log.js";
import { SandboxPolicy } from "../workspace/sandbox-policy.js";
import { AgentRuntime } from "./agent-runtime.js";
import { MapStateStore } from "./map-state-store.js";
import { MapCommandBridge } from "./map-command-bridge.js";
import { VisualizationStateStore } from "./visualization-state-store.js";

export const DEFAULT_RUNTIME_THINKING_LEVEL: ThinkingLevel = "high";

export interface CreateAgentRuntimeOptions {
  cwd?: string;
  session?: SessionManager;
  thinkingLevel?: ThinkingLevel;
  humanInteractionTimeoutMs?: number;
  maxConcurrentTasks?: number;
  maxQueuedTasks?: number;
  /** Defines which prompt contributions and capability-scoped tools exist. */
  hostProfile?: AgentHostProfile;
  /** Allows tests and future hosts to control QGIS discovery. */
  resolveQgisRuntime?: () => Promise<QgisRuntimeInfo | undefined>;
}

/** Build the complete UI-neutral Agent dependency graph. */
export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const authStorage = new AuthStorage();
  const hostProfile = options.hostProfile ?? createAgentHostProfile("cli");
  const mapStateStore = new MapStateStore();
  const mapCommandBridge = new MapCommandBridge();
  const visualizationStateStore = new VisualizationStateStore();
  const modelRuntime = new ModelRuntime(authStorage);
  const session =
    options.session ?? SessionManager.create(options.cwd ?? process.cwd());
  let currentSession = session;
  let qgisRuntime = await (
    options.resolveQgisRuntime ?? detectQgisRuntime
  )();
  const thinkingLevel =
    options.thinkingLevel ?? DEFAULT_RUNTIME_THINKING_LEVEL;
  const humanInteractionBroker = new HumanInteractionBroker({
    defaultTimeoutMs: options.humanInteractionTimeoutMs ?? 5 * 60 * 1_000,
  });
  const taskManager = new TaskManager({
    maxConcurrent: options.maxConcurrentTasks ?? 2,
    maxQueued: options.maxQueuedTasks ?? 50,
  });
  const toolLogger = new ToolExecutionLogger(() =>
    join(
      currentSession.getWorkspaceDir(),
      ".internal",
      "logs",
      "tool-execution.jsonl",
    ),
  );
  const unsubscribeHumanInteractionLog = humanInteractionBroker.subscribe(
    (event) => {
      void toolLogger.record(
        ToolExecutionLogger.createHumanInteractionEvent(event),
      );
    },
  );
  const contextLogger = new ContextUsageLogger(() =>
    join(
      currentSession.getWorkspaceDir(),
      ".internal",
      "logs",
      "context-usage.jsonl",
    ),
  );
  const contextTraceLogger = new ContextTraceLogger(() =>
    join(
      currentSession.getWorkspaceDir(),
      ".internal",
      "logs",
      "context-trace.jsonl",
    ),
  );

  const getSandboxPolicy = (): SandboxPolicy =>
    SandboxPolicy.fromWorkspace(
      currentSession.getWorkspaceDir(),
      currentSession.getProjectDir(),
    );

  const toolRegistry = new ToolRegistry({
    logger: toolLogger,
    permission: { humanInteractionBroker },
    sandbox: getSandboxPolicy,
    hostProfile: () => hostProfile,
  });
  toolRegistry.registerMany(
    createFileTools({ getCwd: () => currentSession.getProjectDir() }),
  );
  for (const tool of createQgisTools(() => qgisRuntime)) {
    toolRegistry.registerSpec(tool);
  }
  toolRegistry.registerMany(createTaskManagementTools(taskManager));
  toolRegistry.registerMany(createMapTools({
    getSessionId: () => currentSession.getSessionId(),
    mapStateStore,
    mapCommandBridge,
  }));

  const delegateTool = createSubagentTool({
    modelRuntime,
    authStorage,
    getCwd: () => currentSession.getProjectDir(),
    getSandboxPolicy,
    getQgisRuntime: () => qgisRuntime,
    toolLogger,
    contextLogger,
    humanInteractionBroker,
    taskManager,
    options: { thinkingLevel },
  });
  toolRegistry.register(delegateTool.definition, delegateTool.handler, {
    isConcurrencySafe: delegateTool.isConcurrencySafe,
    source: "subagent",
    isReadOnly: () => false,
    isDestructive: () => false,
    interruptBehavior: "block",
    getActivityDescription: () => "Delegating subtask",
    getToolUseSummary: (args) =>
      isPlainObject(args) && typeof args.description === "string"
        ? args.description
        : "subagent",
    maxResultSizeChars: 20_000,
  });

  const agentLoop = new AgentLoop(
    modelRuntime,
    authStorage,
    currentSession,
    toolRegistry,
    toolLogger,
    contextLogger,
    contextTraceLogger,
    () => ({
      qgisRuntimeSummary: qgisRuntime
        ? `${qgisRuntime.version} (${qgisRuntime.executablePath})`
        : undefined,
      artifactSummary: formatArtifactSummary(toolRegistry.artifacts.snapshot()),
      taskSummary: formatBackgroundTaskSummary(taskManager.list()),
      additionalWorkingDirectories: [currentSession.getWorkspaceDir()],
      hostPrompt: resolveHostPrompt(hostProfile, {
        mapStateSummary: hasHostCapability(hostProfile, "map_view")
          ? mapStateStore.formatPromptSummary(currentSession.getSessionId())
          : undefined,
        visualizationStateSummary: hasHostCapability(hostProfile, "web_ui")
          ? visualizationStateStore.formatPromptSummary(currentSession.getSessionId())
          : undefined,
      }),
    }),
    humanInteractionBroker,
    taskManager,
  );

  const runtime = new AgentRuntime({
    authStorage,
    modelRuntime,
    session: currentSession,
    qgisRuntime,
    thinkingLevel,
    humanInteractionBroker,
    taskManager,
    toolLogger,
    contextLogger,
    contextTraceLogger,
    toolRegistry,
    agentLoop,
    hostProfile,
    mapStateStore,
    mapCommandBridge,
    visualizationStateStore,
    unsubscribeHumanInteractionLog,
    onSessionChanged: (nextSession) => {
      currentSession = nextSession;
    },
    onQgisRuntimeChanged: (nextRuntime) => {
      qgisRuntime = nextRuntime;
    },
  });

  return runtime;
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

function formatBackgroundTaskSummary(
  tasks: TaskSnapshot[],
): string | undefined {
  if (tasks.length === 0) return undefined;
  return tasks
    .slice(0, 20)
    .map((task) => {
      const progress = task.progress?.percent !== undefined
        ? ` ${task.progress.percent}%`
        : "";
      const readiness = isTaskTerminal(task.status)
        ? "terminal"
        : "artifacts-not-ready";
      return `- ${task.id} [${task.status}${progress}; ${readiness}] ${task.name}`;
    })
    .join("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
