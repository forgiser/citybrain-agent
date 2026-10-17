import type { AgentLoop } from "../agent/agent-loop.js";
import type { AuthStorage } from "../auth/auth-storage.js";
import type { ContextTraceLogger } from "../context/context-trace-log.js";
import type { ContextUsageLogger } from "../context/context-usage-log.js";
import type { HumanInteractionBroker } from "../harness/human-interaction.js";
import type { AgentHostProfile } from "../host/index.js";
import type { QgisRuntimeInfo } from "../integrations/qgis/qgis-runtime.js";
import type { ThinkingLevel } from "../models/model-chat.js";
import type { ModelRuntime } from "../models/model-runtime.js";
import type { SessionManager } from "../session/session-manager.js";
import type { TaskManager } from "../task/index.js";
import type { ToolRegistry } from "../tools/core/execution/tool-registry.js";
import type { ToolExecutionLogger } from "../tools/core/observability/tool-execution-log.js";
import type { MapStateStore } from "./map-state-store.js";
import type { MapCommandBridge } from "./map-command-bridge.js";
import type { VisualizationStateStore } from "./visualization-state-store.js";
import type { WorkspaceProfileScheduler } from "../profile/index.js";
import type { AgentObservabilityService } from "../observability/index.js";
import type { WorkflowService } from "../workflow/index.js";
import type { McpService } from "../mcp/mcp-service.js";

export interface AgentRuntimeDependencies {
  authStorage: AuthStorage;
  modelRuntime: ModelRuntime;
  session: SessionManager;
  qgisRuntime: QgisRuntimeInfo | undefined;
  thinkingLevel: ThinkingLevel;
  humanInteractionBroker: HumanInteractionBroker;
  taskManager: TaskManager;
  toolLogger: ToolExecutionLogger;
  contextLogger: ContextUsageLogger;
  contextTraceLogger: ContextTraceLogger;
  toolRegistry: ToolRegistry;
  agentLoop: AgentLoop;
  hostProfile: AgentHostProfile;
  mapStateStore: MapStateStore;
  mapCommandBridge: MapCommandBridge;
  visualizationStateStore: VisualizationStateStore;
  profileScheduler: WorkspaceProfileScheduler;
  observability: AgentObservabilityService;
  workflows: WorkflowService;
  mcpService: McpService;
  unsubscribeHumanInteractionLog?: () => void;
  unsubscribeProfileTaskEvents?: () => void;
  unsubscribeTaskObservability?: () => void;
  onSessionChanged?: (session: SessionManager) => void;
  onQgisRuntimeChanged?: (runtime: QgisRuntimeInfo | undefined) => void;
}

/**
 * UI-neutral owner of the long-lived services used by an Agent session.
 *
 * CLI and future Web adapters receive this object instead of constructing
 * their own model, tool, task, QGIS and interaction infrastructure.
 */
export class AgentRuntime {
  readonly authStorage: AuthStorage;
  readonly modelRuntime: ModelRuntime;
  readonly humanInteractionBroker: HumanInteractionBroker;
  readonly taskManager: TaskManager;
  readonly toolLogger: ToolExecutionLogger;
  readonly contextLogger: ContextUsageLogger;
  readonly contextTraceLogger: ContextTraceLogger;
  readonly toolRegistry: ToolRegistry;
  readonly agentLoop: AgentLoop;
  readonly hostProfile: AgentHostProfile;
  readonly mapStateStore: MapStateStore;
  readonly mapCommandBridge: MapCommandBridge;
  readonly visualizationStateStore: VisualizationStateStore;
  readonly profileScheduler: WorkspaceProfileScheduler;
  readonly observability: AgentObservabilityService;
  readonly workflows: WorkflowService;
  readonly mcpService: McpService;

  private session: SessionManager;
  private qgisRuntime: QgisRuntimeInfo | undefined;
  private thinkingLevel: ThinkingLevel;
  private readonly unsubscribeHumanInteractionLog?: () => void;
  private readonly unsubscribeProfileTaskEvents?: () => void;
  private readonly unsubscribeTaskObservability?: () => void;
  private readonly onSessionChanged?: (session: SessionManager) => void;
  private readonly onQgisRuntimeChanged?: (
    runtime: QgisRuntimeInfo | undefined,
  ) => void;
  private disposed = false;

  constructor(dependencies: AgentRuntimeDependencies) {
    this.authStorage = dependencies.authStorage;
    this.modelRuntime = dependencies.modelRuntime;
    this.session = dependencies.session;
    this.qgisRuntime = dependencies.qgisRuntime;
    this.thinkingLevel = dependencies.thinkingLevel;
    this.humanInteractionBroker = dependencies.humanInteractionBroker;
    this.taskManager = dependencies.taskManager;
    this.toolLogger = dependencies.toolLogger;
    this.contextLogger = dependencies.contextLogger;
    this.contextTraceLogger = dependencies.contextTraceLogger;
    this.toolRegistry = dependencies.toolRegistry;
    this.agentLoop = dependencies.agentLoop;
    this.hostProfile = dependencies.hostProfile;
    this.mapStateStore = dependencies.mapStateStore;
    this.mapCommandBridge = dependencies.mapCommandBridge;
    this.visualizationStateStore = dependencies.visualizationStateStore;
    this.profileScheduler = dependencies.profileScheduler;
    this.observability = dependencies.observability;
    this.workflows = dependencies.workflows;
    this.mcpService = dependencies.mcpService;
    this.unsubscribeHumanInteractionLog =
      dependencies.unsubscribeHumanInteractionLog;
    this.unsubscribeProfileTaskEvents = dependencies.unsubscribeProfileTaskEvents;
    this.unsubscribeTaskObservability = dependencies.unsubscribeTaskObservability;
    this.onSessionChanged = dependencies.onSessionChanged;
    this.onQgisRuntimeChanged = dependencies.onQgisRuntimeChanged;
  }

  getSession(): SessionManager {
    return this.session;
  }

  getHostProfile(): AgentHostProfile {
    return this.hostProfile;
  }

  setSession(session: SessionManager): void {
    this.assertActive();
    if (session.getWorkspaceDir() !== this.session.getWorkspaceDir() &&
      this.taskManager.list({ workspaceDir: this.session.getWorkspaceDir() }).some((task) =>
        task.metadata?.kind === "workflow" && ["queued", "running"].includes(task.status))) {
      throw new Error("Cannot switch workspaces while a workflow task is active.");
    }
    this.session = session;
    this.agentLoop.setSession(session);
    this.onSessionChanged?.(session);
  }

  getQgisRuntime(): QgisRuntimeInfo | undefined {
    return this.qgisRuntime;
  }

  setQgisRuntime(runtime: QgisRuntimeInfo | undefined): void {
    this.assertActive();
    this.qgisRuntime = runtime;
    this.onQgisRuntimeChanged?.(runtime);
  }

  getThinkingLevel(): ThinkingLevel {
    return this.thinkingLevel;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.assertActive();
    this.thinkingLevel = level;
  }

  /**
   * Release runtime-owned resources. The operation is deliberately idempotent
   * so every adapter can call it from its own shutdown path safely.
   */
  async dispose(reason = "agent runtime disposed"): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeHumanInteractionLog?.();
    this.unsubscribeProfileTaskEvents?.();
    this.unsubscribeTaskObservability?.();
    this.humanInteractionBroker.cancelAll(reason);
    this.taskManager.dispose(reason);
    this.mapCommandBridge.dispose(reason);
    await this.mcpService.dispose();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("AgentRuntime has been disposed.");
    }
  }
}
