import { join } from "node:path";
import { AgentLoop } from "../agent/agent-loop.js";
import { AuthStorage, getCityBrainDir } from "../auth/auth-storage.js";
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
  SqliteTaskStore,
  isTaskTerminal,
  type TaskSnapshot,
} from "../task/index.js";
import {
  createFileTools,
  createHumanInteractionTools,
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
import { WorkspaceProfileScheduler, formatWorkspaceProfilePrompt } from "../profile/index.js";
import { AgentObservabilityService } from "../observability/index.js";
import { WorkflowService } from "../workflow/index.js";
import { McpService } from "../mcp/mcp-service.js";
import { createMcpTools } from "../mcp/mcp-tools.js";

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
  const mcpService = new McpService();
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
    store: new SqliteTaskStore(join(getCityBrainDir(), "tasks.sqlite")),
  });
  const profileScheduler = new WorkspaceProfileScheduler(() => currentSession);
  const observability = new AgentObservabilityService(
    () => currentSession.getWorkspaceDir(),
    () => taskManager.list(),
  );
  const unsubscribeTaskObservability = taskManager.subscribe((event) => {
    void observability.recordTaskEvent(event);
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
  const delegate = createSubagentTool({
    modelRuntime,
    authStorage,
    getCwd: () => currentSession.getProjectDir(),
    getParentSession: () => currentSession,
    getSandboxPolicy,
    getQgisRuntime: () => qgisRuntime,
    toolLogger,
    contextLogger,
    humanInteractionBroker,
    options: { thinkingLevel },
  });
  toolRegistry.register(delegate.definition, delegate.handler, {
    source: "subagent",
    requiredCapabilities: ["subagents"],
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: delegate.isConcurrencySafe,
    interruptBehavior: "cancel",
    getActivityDescription: (input) =>
      `Delegating to ${String(input && typeof input === "object" ? (input as { subagent_type?: unknown }).subagent_type ?? "subagent" : "subagent")}`,
    maxResultSizeChars: 20_000,
  });
  toolRegistry.registerMany(createTaskManagementTools(taskManager));
  toolRegistry.registerMany(createHumanInteractionTools({ humanInteractionBroker }));
  toolRegistry.registerMany(createMcpTools(mcpService));
  toolRegistry.registerMany(createMapTools({
    getSessionId: () => currentSession.getSessionId(),
    mapStateStore,
    mapCommandBridge,
  }));
  const workflows = new WorkflowService(() => currentSession.getWorkspaceDir(), toolRegistry);
  workflows.recover(taskManager);

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
      mcpSummary: mcpService.summary(),
      workspaceProfileSummary: formatWorkspaceProfilePrompt(
        currentSession.getProjectDir(),
        currentSession.getWorkspaceDir(),
      ),
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
    (event) => {
      profileScheduler.schedule({
        paths: event.artifactPaths,
        runId: event.runId,
        sessionId: event.sessionId,
      });
    },
  );

  const unsubscribeProfileTaskEvents = taskManager.subscribe((event) => {
    if (
      event.type !== "completed"
      || event.task.metadata?.detached !== true
      || event.task.metadata?.transientRun === true
      || event.task.artifactPaths.length === 0
    ) return;
    profileScheduler.schedule({
      paths: event.task.artifactPaths,
      runId: typeof event.task.metadata.runId === "string" ? event.task.metadata.runId : undefined,
      sessionId: typeof event.task.metadata.sessionId === "string" ? event.task.metadata.sessionId : undefined,
      projectDir: typeof event.task.metadata.projectDir === "string" ? event.task.metadata.projectDir : undefined,
      workspaceDir: typeof event.task.metadata.workspaceDir === "string" ? event.task.metadata.workspaceDir : undefined,
    });
  });

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
    profileScheduler,
    observability,
    workflows,
    mcpService,
    unsubscribeHumanInteractionLog,
    unsubscribeProfileTaskEvents,
    unsubscribeTaskObservability,
    onSessionChanged: (nextSession) => {
      currentSession = nextSession;
      profileScheduler.recover(nextSession);
      workflows.recover(taskManager);
    },
    onQgisRuntimeChanged: (nextRuntime) => {
      qgisRuntime = nextRuntime;
    },
  });

  if (currentSession.isPersisted()) profileScheduler.recover(currentSession);

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
