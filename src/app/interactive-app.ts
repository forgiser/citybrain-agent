import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  SelectList,
  Spacer,
  Text,
  TuiMainScreen,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type SlashCommand,
  type TUI,
} from "@earendil-works/pi-tui";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { styleText } from "node:util";
import { AgentLoop, type AgentEvent } from "../agent/agent-loop.js";
import type {
  ToolExecutionResult,
  ToolExecutionStarted,
  ToolProgress,
} from "../agent/agent-loop.js";
import type { AgentStatusUpdate } from "../agent/agent-status.js";
import type { AgentHarnessStateUpdate } from "../agent/agent-state.js";
import type { HarnessError } from "../harness/harness-types.js";
import type { HumanInteractionRequest } from "../harness/human-interaction.js";
import type { ContextUsageSnapshot } from "../context/context-usage.js";
import type { AuthStorage } from "../auth/auth-storage.js";
import { LoginDialog } from "../auth/login-dialog.js";
import {
  filterProviderOptions,
  findProviderOption,
  providerOptions,
} from "../auth/providers.js";
import {
  getModelReference,
  type ModelDefinition,
} from "../models/model-catalog.js";
import { ModelRuntime } from "../models/model-runtime.js";
import type { ModelUsage, ThinkingLevel } from "../models/model-chat.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  SessionManager,
} from "../session/session-manager.js";
import type {
  SessionInfo,
  SessionMessageEntry,
} from "../session/session-types.js";
import { clearSystemPromptSections } from "../context/index.js";
import {
  clearConfiguredQgisRuntime,
  configureQgisRuntime,
  findQgisCandidates,
  type QgisRuntimeInfo,
} from "../integrations/qgis/qgis-runtime.js";
import { PathInputDialog } from "../integrations/qgis/path-input-dialog.js";
import {
  QGIS_LTR_DOWNLOAD_URL,
  openInBrowser,
} from "../integrations/qgis/qgis-setup.js";
import {
  describeQgisAlgorithm,
  listQgisAlgorithms,
} from "../integrations/qgis/qgis-process-client.js";
import {
  createAgentRuntime,
  DEFAULT_RUNTIME_THINKING_LEVEL,
  type AgentRuntime,
} from "../runtime/index.js";
import {
  ensureWorkspace,
  type WorkspaceInfo,
} from "../workspace/workspace.js";
import {
  addWorkspaceReadRoot,
  removeWorkspaceReadRoot,
  SandboxPolicy,
} from "../workspace/sandbox-policy.js";
import { findShellCommand, shellCommands } from "./shell-commands.js";
import { CliHumanInteractionAdapter } from "./cli-human-interaction.js";
import {
  isTaskTerminal,
  isToolExecutionTask,
  type TaskManager,
} from "../task/index.js";
import {
  formatObservationReportText,
  type AgentObservabilityService,
} from "../observability/index.js";
import type { WorkflowService } from "../workflow/index.js";
import { evaluateRecordedRun, loadBuiltInEvalCases } from "../eval/index.js";
import type { McpService } from "../mcp/mcp-service.js";

const VERSION = "0.1.0";
const DEFAULT_THINKING_LEVEL: ThinkingLevel = DEFAULT_RUNTIME_THINKING_LEVEL;
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "high", "max"];
let THINKING_LEVEL: ThinkingLevel = DEFAULT_THINKING_LEVEL;

function fgRgb(red: number, green: number, blue: number, text: string): string {
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

function bgRgb(red: number, green: number, blue: number, text: string): string {
  return `\x1b[48;2;${red};${green};${blue}m${text}\x1b[49m`;
}

function underline(text: string): string {
  return `\x1b[4m${text}\x1b[24m`;
}

const colors = {
  black: (text: string) => styleText("black", text),
  dim: (text: string) => styleText("dim", text),
  thinkingText: (text: string) => styleText(["gray", "italic"], text),
  cyan: (text: string) => styleText("cyan", text),
  green: (text: string) => styleText("green", text),
  lightGreen: (text: string) => styleText("greenBright", text),
  toolSuccessBackground: (text: string) => bgRgb(31, 48, 36, text),
  toolSuccessText: (text: string) => fgRgb(135, 184, 145, text),
  yellow: (text: string) => styleText("yellow", text),
  red: (text: string) => styleText("red", text),
  lightRed: (text: string) => styleText("redBright", text),
  toolErrorBackground: (text: string) => bgRgb(66, 39, 39, text),
  toolErrorText: (text: string) => fgRgb(196, 143, 143, text),
  toolTitle: (text: string) => styleText("bold", fgRgb(224, 221, 216, text)),
  brand: (text: string) => styleText("bold", fgRgb(112, 190, 202, text)),
  brandMuted: (text: string) => fgRgb(113, 142, 151, text),
  section: (text: string) => styleText("bold", fgRgb(164, 184, 189, text)),
  toolPath: (text: string) => underline(fgRgb(139, 193, 187, text)),
  humanBackground: (text: string) => bgRgb(63, 57, 35, text),
  humanText: (text: string) => fgRgb(232, 216, 151, text),
  agentTitle: (text: string) => styleText("bold", fgRgb(151, 199, 242, text)),
  agentRunningBackground: (text: string) => bgRgb(38, 52, 68, text),
  agentRunningText: (text: string) => styleText("yellow", text),
  agentDoneText: (text: string) => fgRgb(135, 184, 145, text),
  agentErrorText: (text: string) => fgRgb(196, 143, 143, text),
  white: (text: string) => styleText("white", text),
  userBackground: (text: string) => bgRgb(52, 53, 65, text),
  userText: (text: string) => fgRgb(206, 206, 214, text),
  userTitle: (text: string) => styleText("bold", fgRgb(222, 222, 228, text)),
};

const editorTheme: EditorTheme = {
  borderColor: colors.cyan,
  selectList: {
    selectedPrefix: colors.cyan,
    selectedText: colors.white,
    description: colors.dim,
    scrollInfo: colors.dim,
    noMatch: colors.dim,
  },
};

export async function startInteractiveApp(
  providedRuntime?: AgentRuntime,
): Promise<void> {
  const runtime =
    providedRuntime ??
    (await createAgentRuntime({
      cwd: process.cwd(),
      thinkingLevel: DEFAULT_THINKING_LEVEL,
    }));
  const {
    agentLoop,
    authStorage,
    humanInteractionBroker: humanBroker,
    modelRuntime,
  } = runtime;
  let session = runtime.getSession();
  let qgisRuntime = runtime.getQgisRuntime();
  let thinkingLevel = runtime.getThinkingLevel();
  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiMainScreen(terminal, true);
  const editor = new Editor(tui, editorTheme, {
    paddingX: 1,
    autocompleteMaxVisible: 7,
  });
  editor.borderColor = getThinkingBorderColor(thinkingLevel);
  const transcript: Component[] = [];
  const humanPrompts = new Map<string, HumanInteractionComponent>();
  const humanInteraction = new CliHumanInteractionAdapter(humanBroker, {
    show: (request) => {
      const component = new HumanInteractionComponent(
        request,
        getInitialHumanSelection(request),
      );
      humanPrompts.set(request.requestId, component);
      addTranscript({ editor, transcript, tui }, component);
    },
    select: (request, index) => {
      humanPrompts.get(request.requestId)?.setSelectedIndex(index);
    },
    remove: (request) => {
      const component = humanPrompts.get(request.requestId);
      if (!component) return;
      tui.removeChild(component);
      const index = transcript.indexOf(component);
      if (index >= 0) transcript.splice(index, 1);
      humanPrompts.delete(request.requestId);
    },
    requestRender: () => tui.requestRender(),
  });
  const modelStatus = new FooterStatus();
  const agentStatusFooter = new AgentStatusFooter();
  const sandboxStatus = new SandboxStatus();
  sandboxStatus.setPath(session.getProjectDir());
  const setSession = (nextSession: SessionManager): void => {
    session = nextSession;
    runtime.setSession(nextSession);
    sandboxStatus.setPath(nextSession.getProjectDir());
    tui.requestRender();
  };
  const setQgisRuntime = (nextRuntime: QgisRuntimeInfo | undefined): void => {
    qgisRuntime = nextRuntime;
    runtime.setQgisRuntime(nextRuntime);
  };

  tui.addChild(createHeader());
  tui.addChild(editor);
  tui.addChild(agentStatusFooter);
  tui.addChild(modelStatus);
  tui.addChild(sandboxStatus);
  tui.setFocus(editor);
  editor.setAutocompleteProvider(createAutocompleteProvider(modelRuntime));
  updateModelStatus({ modelRuntime, modelStatus, session, thinkingLevel, tui });
  addTranscript(
    { editor, transcript, tui },
    createSessionStateMessage("new", session),
  );
  addTranscript({ editor, transcript, tui }, createQgisStatusMessage(qgisRuntime));

  return new Promise<void>((resolve) => {
    let stopped = false;
    let unsubscribeTasks: (() => void) | undefined;
    let lastCtrlCAt = 0;
    let ctrlCNotice: Text | undefined;
    let ctrlCNoticeTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      unsubscribeTasks?.();
      humanInteraction.dispose();
      void runtime.dispose("application stopped");
      if (ctrlCNoticeTimer) clearTimeout(ctrlCNoticeTimer);
      tui.stop();
      process.stdout.write("\n");
      resolve();
    };

    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        const now = Date.now();
        if (now - lastCtrlCAt <= 2_000) {
          stop();
          return { consume: true };
        }

        lastCtrlCAt = now;
        if (ctrlCNotice) {
          tui.removeChild(ctrlCNotice);
        }
        ctrlCNotice = new Text(colors.yellow("Press Ctrl+C again within 2 seconds to exit."), 2, 0);
        addTranscript({ editor, transcript, tui }, ctrlCNotice);
        ctrlCNoticeTimer = setTimeout(() => {
          if (ctrlCNotice) {
            tui.removeChild(ctrlCNotice);
            const noticeIndex = transcript.indexOf(ctrlCNotice);
            if (noticeIndex >= 0) transcript.splice(noticeIndex, 1);
            ctrlCNotice = undefined;
            tui.requestRender();
          }
        }, 1_000);
        return { consume: true };
      }
      if (humanInteraction.handleInput(data)) {
        return { consume: true };
      }
      return undefined;
    });

    const createSubmitContext = (): SubmitContext => ({
        editor,
        agentLoop,
        authStorage,
        modelRuntime,
        modelStatus,
        agentStatusFooter,
        sandboxStatus,
        session,
        observability: runtime.observability,
        workflows: runtime.workflows,
        mcpService: runtime.mcpService,
        taskManager: runtime.taskManager,
        setSession,
        setThinkingLevel: (level) => {
          thinkingLevel = level;
          runtime.setThinkingLevel(level);
          THINKING_LEVEL = level;
          editor.borderColor = getThinkingBorderColor(level);
          editor.invalidate();
        },
        thinkingLevel,
        qgisRuntime,
        setQgisRuntime,
        stop,
        transcript,
        tui,
      });
    let submissionChain = Promise.resolve();
    const enqueueSubmit = (
      value: string,
      options: HandleSubmitOptions = {},
    ): void => {
      submissionChain = submissionChain
        .then(() => handleSubmit(value, createSubmitContext(), options))
        .catch((error) => {
          addTranscript(
            { editor, transcript, tui },
            new Text(colors.red(error instanceof Error ? error.message : String(error)), 2, 0),
          );
        });
    };

    editor.onSubmit = (value) => {
      enqueueSubmit(value);
    };

    unsubscribeTasks = runtime.taskManager.subscribe((event) => {
      if (!isTaskTerminal(event.task.status) || !isToolExecutionTask(event.task)) return;
      addTranscript(
        { editor, transcript, tui },
        new Text(
          colors.green(
            `Background task ${event.task.id} ${event.task.status}: ${event.task.description ?? event.task.name}`,
          ),
          2,
          0,
        ),
      );
    });

    tui.start();
    if (!qgisRuntime) {
      void runQgisSetupFlow({ editor, transcript, tui, setQgisRuntime });
    }
    void modelRuntime
      .refreshAll()
      .then((results) => {
        modelRuntime.ensureSelection();
        updateModelStatus({ modelRuntime, modelStatus, session, thinkingLevel, tui });
        const failures = results.filter((result) => result.error);
        if (failures.length > 0) {
          addTranscript(
            {
              editor,
              transcript,
              tui,
            },
            new Text(
              colors.yellow(
                `Provider probe failed: ${failures.map((result) => result.providerId).join(", ")}`,
              ),
              2,
              0,
            ),
          );
        }
      })
      .catch((error) => {
        addTranscript(
          {
            editor,
            transcript,
            tui,
          },
          new Text(
            colors.red(
              `Could not refresh provider models: ${error instanceof Error ? error.message : String(error)}`,
            ),
            2,
            0,
          ),
        );
      });
  });
}

interface SubmitContext {
  editor: Editor;
  agentLoop: AgentLoop;
  authStorage: AuthStorage;
  modelRuntime: ModelRuntime;
  modelStatus: FooterStatus;
  agentStatusFooter: AgentStatusFooter;
  sandboxStatus: SandboxStatus;
  session: SessionManager;
  observability: AgentObservabilityService;
  workflows: WorkflowService;
  mcpService: McpService;
  taskManager: TaskManager;
  setSession: (session: SessionManager) => void;
  qgisRuntime: QgisRuntimeInfo | undefined;
  setQgisRuntime: (runtime: QgisRuntimeInfo | undefined) => void;
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
  stop: () => void;
  transcript: Component[];
  tui: TUI;
}

interface HandleSubmitOptions {
  inputKind?: "user" | "task_notification";
}

const INIT_USE_CURRENT = "__current__";
const INIT_CHOOSE_OTHER = "__choose__";

type TranscriptContext = Pick<SubmitContext, "editor" | "transcript" | "tui">;

async function handleSubmit(
  value: string,
  context: SubmitContext,
  options: HandleSubmitOptions = {},
): Promise<void> {
  const input = value.trim();
  if (!input) return;

  if (options.inputKind !== "task_notification" && input.startsWith("/")) {
    const command = findShellCommand(input);

    if (!command) {
      addTranscript(
        context,
        new Text(`${colors.red("error")} Unknown command: ${input}`, 2, 0),
      );
      return;
    }

    switch (command.name) {
      case "/quit":
        context.stop();
        return;
      case "/new":
      case "/clear":
        clearSystemPromptSections();
        context.session.newSession(context.session.getProjectDir());
        context.setSession(context.session);
        clearTranscript(context);
        addTranscript(context, createSessionStateMessage("new", context.session));
        updateModelStatus(context);
        return;
      case "/help":
        addTranscript(context, createHelpMessage());
        return;
      case "/session":
        addTranscript(context, createSessionInfoMessage(context));
        return;
      case "/observe":
        addTranscript(context, createObservationMessage(getCommandArgument(input), context.observability));
        return;
      case "/workflow":
        await handleWorkflowCommand(getCommandArgument(input), context);
        return;
      case "/eval":
        handleEvalCommand(getCommandArgument(input), context);
        return;
      case "/resume":
        await handleResumeCommand(context);
        return;
      case "/model":
        await handleModelCommand(getCommandArgument(input), context);
        return;
      case "/thinking":
        await handleThinkingCommand(getCommandArgument(input), context);
        return;
      case "/qgis":
        await handleQgisCommand(getCommandArgument(input), context);
        return;
      case "/mcp":
        await handleMcpCommand(getCommandArgument(input), context);
        return;
      case "/workspace":
        await handleWorkspaceCommand(getCommandArgument(input), context);
        return;
      case "/login":
        await handleLoginCommand(getCommandArgument(input), context);
        return;
      case "/logout":
        await handleLogoutCommand(getCommandArgument(input), context);
        return;
    }
  }

  // First question of a session: ensure the project workspace skeleton exists,
  // creating it under the session's working directory if missing.
  if (context.session.getMessageCount() === 0) {
    const info = ensureWorkspace(context.session.getProjectDir());
    if (info.created.length > 0) {
      addTranscript(context, createWorkspaceMessage(info));
    }
  }

  if (options.inputKind !== "task_notification") {
    addTranscript(context, createUserMessage(input));
  }

  const responseComponent = new AssistantResponseComponent();
  addTranscript(context, responseComponent);
  context.editor.disableSubmit = true;
  context.agentStatusFooter.clear();

  try {
    const eventStream = context.agentLoop.run(input, {
      thinkingLevel: context.thinkingLevel,
      inputKind: options.inputKind,
    });
    for await (const event of eventStream) {
      if (event.type === "text") {
        responseComponent.appendText(event.delta);
        context.tui.requestRender();
        continue;
      }
      if (event.type === "thinking") {
        responseComponent.appendThinking(event.delta);
        context.tui.requestRender();
        continue;
      }
      if (event.type === "tool_started") {
        // delegate is rendered as its own agent status line, not a tool box.
        if (event.name !== "delegate") {
          responseComponent.startTool(event);
        }
        context.tui.requestRender();
        continue;
      }
      if (event.type === "tool_progress") {
        if (event.name !== "delegate") {
          responseComponent.updateToolProgress(event);
        }
        context.tui.requestRender();
        continue;
      }
      if (event.type === "tool_lifecycle") {
        if (event.name !== "delegate") {
          responseComponent.updateToolLifecycle(event);
        }
        context.tui.requestRender();
        continue;
      }
      if (event.type === "harness_error") {
        if (event.name !== "delegate") {
          responseComponent.setHarnessStatus(formatHarnessErrorStatus(event.error));
        }
        context.tui.requestRender();
        continue;
      }
      if (event.type === "tool_result") {
        if (event.name !== "delegate") {
          responseComponent.completeTool(event);
        }
        context.tui.requestRender();
        continue;
      }
      if (event.type === "agent_status") {
        context.agentStatusFooter.setStatus(event);
        context.tui.requestRender();
        continue;
      }
      if (event.type === "state") {
        responseComponent.setHarnessStatus(formatHarnessStatus(event));
        context.tui.requestRender();
        continue;
      }
      if (event.type === "context") {
        context.modelStatus.setContextUsage(event.snapshot);
        responseComponent.setContextUsage(event.snapshot);
        context.tui.requestRender();
        continue;
      }
    }
    responseComponent.setHarnessStatus("");
    responseComponent.setCompleted();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    responseComponent.setError(message);
  } finally {
    context.editor.disableSubmit = false;
    updateModelStatus(context);
    context.tui.requestRender();
  }
}

function clearTranscript(context: TranscriptContext): void {
  for (const item of context.transcript) {
    context.tui.removeChild(item);
  }
  context.transcript.length = 0;
  context.tui.requestRender();
}

function addTranscript(context: TranscriptContext, component: Component): void {
  const editorIndex = context.tui.children.indexOf(context.editor);
  context.tui.children.splice(editorIndex, 0, component);
  context.transcript.push(component);
  context.tui.requestRender();
}

function renderStoredSession(
  context: TranscriptContext & Pick<SubmitContext, "session">,
): void {
  for (const entry of context.session.getEntries()) {
    if (entry.type === "message") {
      if (entry.message.visibility === "system") continue;
      if (entry.message.role === "tool" || entry.message.toolCalls?.length) {
        continue;
      }
      addTranscript(context, createSessionMessage(entry));
    }
  }
}

function createSessionMessage(entry: SessionMessageEntry): Component {
  if (entry.message.role === "user") {
    return createUserMessage(entry.message.content);
  }

  const response = new AssistantResponseComponent();
  response.setContent(entry.message.thinking ?? "", entry.message.content, false);
  return response;
}

function createSessionInfoMessage(
  context: Pick<SubmitContext, "modelRuntime" | "session" | "thinkingLevel">,
): Text {
  const model = context.modelRuntime.getSelectedModel();
  const usage = context.session.getContextUsage(
    model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  );
  const info = context.session.getInfo();
  return new Text(
    [
      colors.cyan("session"),
      `  id: ${info.id}`,
      `  messages: ${info.messageCount}`,
      `  context: ${formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)} (${usage.percent.toFixed(1)}%)${usage.estimated ? " estimated" : " measured"}`,
      `  thinking: ${context.thinkingLevel}`,
      `  file: ${info.path}`,
    ].join("\n"),
    2,
    0,
  );
}

function createObservationMessage(
  argument: string | undefined,
  observability: AgentObservabilityService,
): Text {
  const [requestedView = "summary", rawLimit] = (argument ?? "").trim().split(/\s+/u);
  const allowed = new Set(["summary", "runs", "tools", "errors", "timeline"]);
  const view = allowed.has(requestedView) ? requestedView : "summary";
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 200;
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 200;
  return new Text(
    formatObservationReportText(observability.getReport({ limit }), view),
    2,
    0,
  );
}

async function handleWorkflowCommand(argument: string | undefined, context: SubmitContext): Promise<void> {
  const [operation = "list", id] = (argument ?? "").trim().split(/\s+/u);
  let message: string;
  try {
    if (operation === "list") {
      const workflows = context.workflows.list();
      message = workflows.length > 0
        ? workflows.map((item) => `${item.id} · ${item.name} · ${item.nodes.length} nodes`).join("\n")
        : "当前工作区还没有工作流。使用 /workflow draft <Agent Run ID> 创建草稿。";
    } else if (operation === "draft" && id) {
      const workflow = context.workflows.createFromRun(id);
      message = `已创建 ${workflow.id}（${workflow.nodes.length} 个节点）。使用 /workflow show ${workflow.id} 检查后再执行。`;
    } else if (operation === "show" && id) {
      const workflow = context.workflows.get(id);
      message = `${workflow.name} (${workflow.id})\n${workflow.nodes.map((node) => `- ${node.id}: ${node.tool} · dependencies ${node.dependencies.join(", ") || "none"} · outputs ${node.outputPaths.join(", ") || "none"}`).join("\n")}`;
    } else if (operation === "run" && id) {
      const task = context.workflows.submit(context.taskManager, id);
      message = `工作流任务已提交：${task.id}。可使用 /workflow status ${id} 查看节点状态。`;
    } else if (operation === "status" && id) {
      const execution = context.workflows.getExecution(id);
      message = execution
        ? `${id}: ${execution.status}\n${Object.values(execution.nodes).map((node) => `- ${node.nodeId}: ${node.status}${node.error ? ` · ${node.error}` : ""}`).join("\n")}`
        : "该工作流还没有执行记录。";
    } else {
      message = "用法：/workflow list | draft <Agent Run ID> | show <workflow ID> | run <workflow ID> | status <workflow ID>";
    }
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  addTranscript(context, new Text(message, 2, 0));
}

function handleEvalCommand(argument: string | undefined, context: SubmitContext): void {
  const [operation = "cases", caseId, runId] = (argument ?? "").trim().split(/\s+/u);
  let message: string;
  try {
    const cases = loadBuiltInEvalCases();
    if (operation === "cases") {
      message = cases.map((item) => `${item.id} · ${item.name} · ${item.tags?.join(", ") ?? ""}`).join("\n");
    } else if (operation === "run" && caseId && runId) {
      const selected = cases.find((item) => item.id === caseId);
      if (!selected) throw new Error(`评测用例不存在：${caseId}`);
      const result = evaluateRecordedRun({ ...selected, projectDir: context.session.getProjectDir() }, runId);
      message = `${result.passed ? "通过" : "未通过"} · ${selected.name} · Run ${runId}\n${result.checks.map((check) => `${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`).join("\n")}\n工具 ${result.metrics.toolCalls} · Token ${result.metrics.totalTokens} · 耗时 ${result.metrics.durationMs} ms`;
    } else {
      message = "用法：/eval cases | /eval run <caseId> <Run ID>；批量和隔离执行请用 citybrain eval --help";
    }
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  addTranscript(context, new Text(message, 2, 0));
}

function createQgisStatusMessage(runtime: QgisRuntimeInfo | undefined): Text {
  if (!runtime) {
    return new Text(
      [
        colors.yellow("QGIS PROCESS   ! unavailable"),
        colors.dim("  Spatial analysis tools are disabled. Configure it with /qgis."),
      ].join("\n"),
      2,
      0,
    );
  }

  return new Text(
    [
      colors.lightGreen("QGIS PROCESS   ● ready"),
      `  ${colors.dim(runtime.version.replace(/\s*\(.*/u, ""))}`,
      colors.dim("  Use /qgis info for runtime details."),
    ].join("\n"),
    2,
    0,
  );
}

function createSessionStateMessage(
  state: "new" | "resumed",
  session: SessionManager,
): Text {
  const info = session.getInfo();
  const color = state === "new" ? colors.green : colors.cyan;
  const title = state === "new" ? "new session" : "resumed session";
  const detail = state === "new"
    ? "ready for a city analysis"
    : `${info.messageCount} messages`;
  return new Text(
    [
      colors.brand("  CITYBRAIN  /  CITY DATA WORKSPACE"),
      colors.brandMuted("  ────────────────────────────────────────────────"),
      `${colors.section("  WORKSPACE")}  ${colors.toolPath(session.getProjectDir())}`,
      `${colors.section("  CITYBRAIN")}  ${colors.toolPath(session.getWorkspaceDir())}`,
      `${color("  " + title)}  ${colors.dim(info.id.slice(0, 8))}  ${colors.dim(detail)}${session.isPersisted() ? "" : `  ${colors.dim("(not saved)")}`}`,
      colors.brandMuted("  ────────────────────────────────────────────────"),
    ].join("\n"),
    2,
    0,
  );
}

function createUserMessage(input: string): Box {
  const userMessage = new Box(2, 1, colors.userBackground);
  userMessage.addChild(
    new Text(`${colors.userTitle("you")}\n\n${colors.userText(input)}`, 0, 0),
  );
  return userMessage;
}

class HumanInteractionComponent extends Box {
  private readonly content: Text;
  private selectedIndex: number;

  constructor(
    private readonly request: HumanInteractionRequest,
    selectedIndex: number,
  ) {
    super(1, 1, colors.humanBackground);
    this.selectedIndex = selectedIndex;
    this.content = new Text(formatHumanRequest(request, selectedIndex), 0, 0);
    this.addChild(this.content);
  }

  setSelectedIndex(index: number): void {
    this.selectedIndex = index;
    this.content.setText(formatHumanRequest(this.request, index));
  }
}

function getInitialHumanSelection(request: HumanInteractionRequest): number {
  const defaultIndex = request.options.findIndex(
    (option) => option.id === request.defaultOption,
  );
  return defaultIndex >= 0 ? defaultIndex : 0;
}

function formatHumanRequest(
  request: HumanInteractionRequest,
  selectedIndex: number,
): string {
  const options = request.options
    .map((option, index) => {
      const description = option.description ? `  ${option.description}` : "";
      const prefix = index === selectedIndex ? "› " : "  ";
      const optionLabel = `${option.label}${option.recommended ? " · recommended" : ""}`;
      const label = index === selectedIndex
        ? colors.humanText(optionLabel)
        : optionLabel;
      return `${prefix}${label}${description}`;
    })
    .join("\n");
  return [
    colors.humanText(`human input required · ${request.kind}`),
    colors.humanText(request.title),
    request.message,
    colors.dim(`risk=${request.risk ?? "medium"}`),
    options,
    colors.dim("Use ↑/↓ to select, Enter to confirm, or Esc to cancel."),
  ].join("\n");
}

function createHeader(): Text {
  return new Text(
    [
      colors.brand("  ◆ CITYBRAIN"),
      colors.brandMuted("  ── urban data intelligence / geospatial analysis"),
      colors.dim(`  v${VERSION}  ·  city analysis workspace`),
      "",
      colors.white("  Explore data  ·  reason spatially  ·  produce evidence"),
      colors.dim("  Type / for commands  ·  /workspace to switch workspace"),
    ].join("\n"),
    0,
    1,
  );
}

function createAutocompleteProvider(modelRuntime: ModelRuntime): CombinedAutocompleteProvider {
  const commands: SlashCommand[] = shellCommands.flatMap((command) => {
    const names = [
      command.name.slice(1),
      ...(command.aliases ?? []).map((alias) => alias.slice(1)),
    ];

    return names.map((name) => ({
      name,
      description: command.description,
      argumentHint: command.argumentHint,
      getArgumentCompletions:
        command.name === "/model"
          ? () =>
              modelRuntime.getAvailableModels().map((model) => ({
                value: getModelReference(model),
                label: getModelReference(model),
                description: model.description,
              }))
          : command.name === "/thinking"
          ? () =>
              THINKING_LEVELS.map((level) => ({
                value: level,
                label: level,
                description:
                  level === "off"
                    ? "No reasoning"
                    : level === "high"
                      ? "Deep reasoning"
                      : "Maximum reasoning",
              }))
          : command.name === "/login" || command.name === "/logout"
          ? (prefix: string) =>
              filterProviderOptions(prefix).map((provider) => ({
                value: provider.id,
                label: provider.id,
                description: provider.description,
              }))
          : undefined,
    }));
  });

  return new CombinedAutocompleteProvider(commands, process.cwd());
}

function createHelpMessage(): Text {
  const rows = shellCommands.map((command) => {
    const aliases = command.aliases?.length ? ` (${command.aliases.join(", ")})` : "";
    return `  ${command.name.padEnd(8)} ${command.description}${aliases}`;
  });

  return new Text(
    [
      colors.cyan("commands"),
      ...rows,
      "",
      colors.dim("Up/Down select   Enter accept   Esc close"),
    ].join("\n"),
    2,
    0,
  );
}

function getCommandArgument(input: string): string | undefined {
  const [, ...argumentsList] = input.trim().split(/\s+/);
  return argumentsList.length > 0 ? argumentsList.join(" ") : undefined;
}

async function handleLoginCommand(
  providerArgument: string | undefined,
  context: SubmitContext,
): Promise<void> {
  if (providerArgument && providerArgument.split(/\s+/).length > 1) {
    addTranscript(
      context,
      new Text(`${colors.yellow("usage")}  /login <provider>`, 2, 0),
    );
    return;
  }

  const providerId = providerArgument || (await selectProvider(context, "Select a provider to configure"));
  if (!providerId) {
    addTranscript(context, new Text(colors.dim("Login cancelled."), 2, 0));
    return;
  }

  const provider = findProviderOption(providerId) ?? {
    id: providerId.trim().toLowerCase(),
    name: providerId.trim(),
    description: "Custom provider",
  };
  if (!provider.id) {
    addTranscript(context, new Text(`${colors.yellow("usage")}  /login <provider>`, 2, 0));
    return;
  }

  const dialog = new LoginDialog(
    context.tui,
    provider.name,
    colors.cyan,
    colors.dim,
  );
  const editorIndex = context.tui.children.indexOf(context.editor);
  context.tui.children.splice(editorIndex, 0, dialog);
  context.tui.setFocus(dialog);
  context.tui.requestRender();

  const key = await dialog.open();
  context.tui.removeChild(dialog);
  context.tui.setFocus(context.editor);
  context.tui.requestRender();

  if (key === undefined) {
    addTranscript(context, new Text(colors.dim("Login cancelled."), 2, 0));
    return;
  }

  try {
    context.authStorage.setApiKey(provider.id, key);
    const probedModels = await context.modelRuntime.refreshProvider(provider.id);
    const selectedModel = context.modelRuntime.ensureSelection(provider.id);
    updateModelStatus(context);
    addTranscript(
      context,
      new Text(
        [
          colors.green("login complete"),
          `  Provider: ${provider.id}`,
          `  Models discovered: ${probedModels.length}`,
          selectedModel ? `  Model: ${getModelReference(selectedModel)}` : "  Model: not configured",
          `  Saved to: ${context.authStorage.getPath()}`,
        ].join("\n"),
        2,
        0,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateModelStatus(context);
    addTranscript(
      context,
      new Text(
        [
          colors.red("provider probe failed"),
          `  Credential saved to: ${context.authStorage.getPath()}`,
          `  ${message}`,
        ].join("\n"),
        2,
        0,
      ),
    );
  }
}

async function handleLogoutCommand(
  providerArgument: string | undefined,
  context: SubmitContext,
): Promise<void> {
  let providerId = providerArgument?.trim().toLowerCase();
  if (!providerId) {
    const loggedInProviders = context.authStorage.list();
    if (loggedInProviders.length === 0) {
      addTranscript(
        context,
        new Text(colors.yellow("No saved credentials to remove."), 2, 0),
      );
      return;
    }

    providerId = await selectProvider(
      context,
      "Select a provider to log out",
      loggedInProviders.map(
        (providerId) =>
          findProviderOption(providerId) ?? {
            id: providerId,
            name: providerId,
            description: "Custom provider",
          },
      ),
    );
    if (!providerId) {
      addTranscript(context, new Text(colors.dim("Logout cancelled."), 2, 0));
      return;
    }
  }

  if (providerId.split(/\s+/).length > 1) {
    addTranscript(
      context,
      new Text(`${colors.yellow("usage")}  /logout [provider]`, 2, 0),
    );
    return;
  }

  if (!context.authStorage.remove(providerId)) {
    addTranscript(
      context,
      new Text(colors.yellow(`No saved credentials for ${providerId}.`), 2, 0),
    );
    return;
  }

  const nextModel = context.modelRuntime.handleProviderLogout(providerId);
  updateModelStatus(context);
  addTranscript(
    context,
    new Text(
      [
        colors.green(`Logged out from ${providerId}.`),
        nextModel ? `  Active model: ${getModelReference(nextModel)}` : "  Active model: not configured",
      ].join("\n"),
      2,
      0,
    ),
  );
}

async function handleInitCommand(
  targetArgument: string | undefined,
  context: SubmitContext,
): Promise<void> {
  let targetDir = targetArgument
    ?.trim()
    .replace(/^(["'])(.*)\1$/u, "$2");
  if (!targetDir) {
    const choice = await selectInitTarget(context);
    if (!choice) {
      addTranscript(context, new Text(colors.dim("Init cancelled."), 2, 0));
      return;
    }
    if (choice === INIT_CHOOSE_OTHER) {
      targetDir = await promptWorkspacePath(context);
      if (!targetDir) {
        addTranscript(context, new Text(colors.dim("Init cancelled."), 2, 0));
        return;
      }
    } else {
      targetDir = context.session.getProjectDir();
    }
  }

  try {
    const info = ensureWorkspace(targetDir);
    context.session.setWorkspaceDir(info.workspaceDir);
    context.sandboxStatus.setPath(info.projectDir);
    addTranscript(context, createWorkspaceMessage(info));
  } catch (error) {
    addTranscript(
      context,
      new Text(
        `${colors.red("init failed")}  ${error instanceof Error ? error.message : String(error)}`,
        2,
        0,
      ),
    );
  }
}

async function handleWorkspaceCommand(
  argument: string | undefined,
  context: SubmitContext,
): Promise<void> {
  const value = argument?.trim();
  if (!value || value.toLowerCase() === "info") {
    const policy = SandboxPolicy.fromWorkspace(
      context.session.getWorkspaceDir(),
      context.session.getProjectDir(),
    );
    addTranscript(
      context,
      new Text(
        [
          colors.cyan("workspace"),
          `  ${context.session.getProjectDir()}`,
          `  citybrain: ${context.session.getWorkspaceDir()}`,
          "",
          policy.describe(),
        ].join("\n"),
        2,
        0,
      ),
    );
    return;
  }

  const [action, ...pathParts] = value.split(/\s+/u);
  if (action === "add-read" || action === "remove-read") {
    await handleWorkspaceReadRoot(action, pathParts.join(" "), context);
    return;
  }

  const targetDir = value.replace(/^(?:workspace\s+)?(["'])(.*)\1$/u, "$2").trim();
  if (!targetDir) {
    addTranscript(context, new Text(colors.dim("workspace switch cancelled"), 2, 0));
    return;
  }

  const resolvedTarget = isAbsolute(targetDir)
    ? resolve(targetDir)
    : resolve(context.session.getProjectDir(), targetDir);
  try {
    const info = ensureWorkspace(resolvedTarget);
    clearSystemPromptSections();
    context.session.newSession(info.projectDir);
    context.setSession(context.session);
    context.sandboxStatus.setPath(info.projectDir);
    addTranscript(
      context,
      new Text(
        [
          colors.green("workspace switched"),
          `  workspace: ${info.projectDir}`,
          `  citybrain: ${info.workspaceDir}`,
          colors.dim("  agent context reset for the new workspace"),
        ].join("\n"),
        2,
        0,
      ),
    );
    updateModelStatus(context);
  } catch (error) {
    addTranscript(
      context,
      new Text(
        `${colors.red("workspace failed")}  ${error instanceof Error ? error.message : String(error)}`,
        2,
        0,
      ),
    );
  }
}

async function handleWorkspaceReadRoot(
  action: "add-read" | "remove-read",
  rawPath: string,
  context: SubmitContext,
): Promise<void> {
  const requestedPath = rawPath.replace(/^(?:["'])(.*)\1$/u, "$1").trim();
  if (!requestedPath) {
    addTranscript(
      context,
      new Text(
        colors.yellow("usage") + "  /workspace " + action + " <directory>",
        2,
        0,
      ),
    );
    return;
  }

  const resolvedReadRoot = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(context.session.getProjectDir(), requestedPath);
  if (!existsSync(resolvedReadRoot) || !statSync(resolvedReadRoot).isDirectory()) {
    addTranscript(
      context,
      new Text(colors.red("workspace failed") + `  Directory not found: ${resolvedReadRoot}`, 2, 0),
    );
    return;
  }

  const policy = SandboxPolicy.fromWorkspace(
    context.session.getWorkspaceDir(),
    context.session.getProjectDir(),
  );
  const manifest = action === "add-read"
    ? addWorkspaceReadRoot(policy.workspaceRoot, policy.projectDir, resolvedReadRoot)
    : removeWorkspaceReadRoot(policy.workspaceRoot, policy.projectDir, resolvedReadRoot);
  addTranscript(
    context,
    new Text(
      [
        colors.green(action === "add-read" ? "read root added" : "read root removed"),
        `  ${resolvedReadRoot}`,
        colors.dim(`  workspace: ${manifest.projectDir}`),
      ].join("\n"),
      2,
      0,
    ),
  );
}

async function handleSandboxCommand(
  argument: string | undefined,
  context: SubmitContext,
): Promise<void> {
  const policy = SandboxPolicy.fromWorkspace(
    context.session.getWorkspaceDir(),
    context.session.getProjectDir(),
  );
  const value = argument?.trim();
  if (!value) {
    addTranscript(
      context,
      new Text(colors.cyan("sandbox") + "\n" + policy.describe(), 2, 0),
    );
    return;
  }

  const [action, ...pathParts] = value.split(/\s+/);
  const requestedPath = pathParts
    .join(" ")
    .replace(/^(["'])(.*)\1$/u, "$2")
    .trim();
  if (!requestedPath || !["add-read", "remove-read"].includes(action ?? "")) {
    addTranscript(
      context,
      new Text(
        [
          colors.yellow("usage"),
          "  /sandbox",
          "  /sandbox add-read <directory>",
          "  /sandbox remove-read <directory>",
        ].join("\n"),
        2,
        0,
      ),
    );
    return;
  }

  const resolvedReadRoot = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(context.session.getProjectDir(), requestedPath);
  if (!existsSync(resolvedReadRoot) || !statSync(resolvedReadRoot).isDirectory()) {
    addTranscript(
      context,
      new Text(
        colors.red("sandbox failed") + `  Directory not found: ${resolvedReadRoot}`,
        2,
        0,
      ),
    );
    return;
  }

  const manifest = action === "add-read"
    ? addWorkspaceReadRoot(policy.workspaceRoot, policy.projectDir, resolvedReadRoot)
    : removeWorkspaceReadRoot(policy.workspaceRoot, policy.projectDir, resolvedReadRoot);
  addTranscript(
    context,
    new Text(
      [
        colors.green(action === "add-read" ? "read root added" : "read root removed"),
        `  ${resolvedReadRoot}`,
        "",
        `  sandbox root: ${manifest.sandboxRoot}`,
        `  workspace/control dir: ${manifest.workspaceRoot}`,
        `  write root: ${manifest.sandboxRoot}`,
        `  read roots: ${manifest.readRoots.join(", ")}`,
      ].join("\n"),
      2,
      0,
    ),
  );
}

async function selectInitTarget(context: SubmitContext): Promise<string | undefined> {
  const selector = new SelectList(
    [
      {
        value: INIT_USE_CURRENT,
        label: "当前文件夹（默认）",
        description: context.session.getProjectDir(),
      },
      {
        value: INIT_CHOOSE_OTHER,
        label: "选择其他文件夹...",
        description: "输入目标文件夹路径，在其下创建 citybrain/",
      },
    ],
    2,
    editorTheme.selectList,
  );
  const selectorIndex = context.tui.children.indexOf(context.editor);
  const titleComponent = new Text(colors.cyan("  初始化 CityBrain 项目工作区"), 2, 0);
  context.tui.children.splice(selectorIndex, 0, titleComponent);
  context.tui.children.splice(selectorIndex + 1, 0, selector);
  context.tui.setFocus(selector);
  context.tui.requestRender();

  return new Promise<string | undefined>((resolve) => {
    const finish = (value: string | undefined): void => {
      context.tui.removeChild(titleComponent);
      context.tui.removeChild(selector);
      context.tui.setFocus(context.editor);
      context.tui.requestRender();
      resolve(value);
    };
    selector.onSelect = (item) => finish(item.value);
    selector.onCancel = () => finish(undefined);
  });
}

async function promptWorkspacePath(context: SubmitContext): Promise<string | undefined> {
  const dialog = new PathInputDialog(
    context.tui,
    "初始化工作区 — 目标文件夹",
    colors.cyan,
    colors.dim,
    [
      "输入目标文件夹路径，将在其下创建 citybrain/ 目录骨架",
      "例如  E:\\projects\\蒲胶流域",
    ],
  );
  const editorIndex = context.tui.children.indexOf(context.editor);
  context.tui.children.splice(editorIndex, 0, dialog);
  context.tui.setFocus(dialog);
  context.tui.requestRender();

  const path = await dialog.open();
  context.tui.removeChild(dialog);
  context.tui.setFocus(context.editor);
  context.tui.requestRender();

  const cleaned = path?.trim().replace(/^(["'])(.*)\1$/u, "$2");
  return cleaned || undefined;
}

function createWorkspaceMessage(info: WorkspaceInfo): Text {
  const status = info.alreadyInitialized
    ? colors.cyan("workspace ready")
    : colors.green("workspace initialized");
  const createdNote =
    info.created.length > 0
      ? colors.dim(
          `  created ${info.created.length} path${info.created.length > 1 ? "s" : ""}`,
        )
      : colors.dim("  already up to date");
  return new Text(
    [status, `  ${info.workspaceDir}`, createdNote].join("\n"),
    2,
    0,
  );
}

async function handleResumeCommand(context: SubmitContext): Promise<void> {
  const currentPath = context.session.getSessionFile();
  const sessions = [
    ...SessionManager.list(process.cwd()),
    ...SessionManager.list(context.session.getProjectDir()),
  ]
    .filter(
      (session, index, all) =>
        all.findIndex((candidate) => candidate.path === session.path) === index,
    )
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  if (sessions.length === 0) {
    addTranscript(
      context,
      new Text(colors.yellow("No previous conversation sessions found."), 2, 0),
    );
    return;
  }

  const selectedPath = await selectSession(context, sessions, currentPath);
  if (!selectedPath) {
    addTranscript(context, new Text(colors.dim("Resume cancelled."), 2, 0));
    return;
  }

  if (selectedPath === currentPath) {
    addTranscript(context, new Text(colors.yellow("This session is already active."), 2, 0));
    return;
  }

  try {
    const nextSession = SessionManager.open(selectedPath);
    context.setSession(nextSession);
    context.session = nextSession;
    clearTranscript(context);
    addTranscript(context, createSessionStateMessage("resumed", nextSession));
    renderStoredSession(context);
    updateModelStatus(context);
  } catch (error) {
    addTranscript(
      context,
      new Text(
        `${colors.red("resume failed")} ${error instanceof Error ? error.message : String(error)}`,
        2,
        0,
      ),
    );
  }
}

async function selectSession(
  context: SubmitContext,
  sessions: SessionInfo[],
  currentPath: string,
): Promise<string | undefined> {
  const selector = new SessionSelectList(
    sessions.map((session) => ({
      value: session.path,
      label: `${formatSessionTime(session.modifiedAt)}  ${formatSessionTitle(session.firstMessage)}`,
      description: `${session.path === currentPath ? "active | " : ""}${session.messageCount} messages | ${session.id.slice(0, 8)}`,
      active: session.path === currentPath,
    })),
  );
  const selectorIndex = context.tui.children.indexOf(context.editor);
  const titleComponent = new Text(colors.cyan("  Resume a conversation"), 2, 0);
  context.tui.children.splice(selectorIndex, 0, titleComponent);
  context.tui.children.splice(selectorIndex + 1, 0, selector);
  context.tui.setFocus(selector);
  context.tui.requestRender();

  return new Promise<string | undefined>((resolve) => {
    const finish = (value: string | undefined): void => {
      context.tui.removeChild(titleComponent);
      context.tui.removeChild(selector);
      context.tui.setFocus(context.editor);
      context.tui.requestRender();
      resolve(value);
    };

    selector.onSelect = (item) => finish(item.value);
    selector.onCancel = () => finish(undefined);
  });
}

function formatSessionTitle(firstMessage: string | undefined): string {
  return firstMessage?.replace(/\s+/gu, " ").trim().slice(0, 72) || "(empty session)";
}

function formatSessionTime(modifiedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(modifiedAt));
}

async function selectProvider(
  context: SubmitContext,
  title: string,
  options = providerOptions,
): Promise<string | undefined> {
  const selector = new SelectList(
    options.map((provider) => ({
      value: provider.id,
      label: provider.name,
      description: provider.description,
    })),
    6,
    editorTheme.selectList,
  );
  const selectorIndex = context.tui.children.indexOf(context.editor);
  context.tui.children.splice(selectorIndex, 0, new Text(colors.cyan(`  ${title}`), 2, 0));
  const titleComponent = context.tui.children[selectorIndex]!;
  context.tui.children.splice(selectorIndex + 1, 0, selector);
  context.tui.setFocus(selector);
  context.tui.requestRender();

  return new Promise<string | undefined>((resolve) => {
    const finish = (value: string | undefined): void => {
      context.tui.removeChild(titleComponent);
      context.tui.removeChild(selector);
      context.tui.setFocus(context.editor);
      context.tui.requestRender();
      resolve(value);
    };

    selector.onSelect = (item) => finish(item.value);
    selector.onCancel = () => finish(undefined);
  });
}

async function handleModelCommand(
  modelArgument: string | undefined,
  context: SubmitContext,
): Promise<void> {
  if (modelArgument && modelArgument.split(/\s+/).length > 1) {
    addTranscript(
      context,
      new Text(`${colors.yellow("usage")}  /model [provider/model]`, 2, 0),
    );
    return;
  }

  const availableModels = context.modelRuntime.getAvailableModels();
  if (availableModels.length === 0) {
    addTranscript(
      context,
      new Text(
        colors.yellow("No probed models available. Run /login again to refresh this provider."),
        2,
        0,
      ),
    );
    return;
  }

  if (modelArgument) {
    try {
      const selected = context.modelRuntime.selectModelReference(modelArgument);
      if (context.session.isPersisted()) {
        context.session.appendModelChange(selected.provider, selected.id);
      }
      updateModelStatus(context);
      addTranscript(
        context,
        new Text(
          colors.green(`Active model: ${getModelReference(selected)}`),
          2,
          0,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addTranscript(context, new Text(`${colors.red("error")} ${message}`, 2, 0));
    }
    return;
  }

  const selected = await selectModel(context, availableModels);
  if (!selected) {
    addTranscript(context, new Text(colors.dim("Model selection cancelled."), 2, 0));
    return;
  }

  context.modelRuntime.selectModel(selected);
  if (context.session.isPersisted()) {
    context.session.appendModelChange(selected.provider, selected.id);
  }
  updateModelStatus(context);
  addTranscript(
    context,
    new Text(colors.green(`Active model: ${getModelReference(selected)}`), 2, 0),
  );
}

async function handleThinkingCommand(
  thinkingArgument: string | undefined,
  context: SubmitContext,
): Promise<void> {
  if (thinkingArgument && thinkingArgument.split(/\s+/).length > 1) {
    addTranscript(
      context,
      new Text(`${colors.yellow("usage")}  /thinking [off|high|max]`, 2, 0),
    );
    return;
  }

  if (!thinkingArgument) {
    const selector = new SelectList(
      THINKING_LEVELS.map((level) => ({
        value: level,
        label: level,
        description:
          level === "off"
            ? "No reasoning"
            : level === "high"
              ? "Deep reasoning"
              : "Maximum reasoning",
      })),
      THINKING_LEVELS.length,
      editorTheme.selectList,
    );
    selector.setSelectedIndex(THINKING_LEVELS.indexOf(context.thinkingLevel));
    const selectorIndex = context.tui.children.indexOf(context.editor);
    const titleComponent = new Text(colors.cyan("  Select thinking level"), 2, 0);
    context.tui.children.splice(selectorIndex, 0, titleComponent);
    context.tui.children.splice(selectorIndex + 1, 0, selector);
    context.tui.setFocus(selector);
    context.tui.requestRender();

    await new Promise<void>((resolve) => {
      const finish = (level?: string): void => {
        context.tui.removeChild(titleComponent);
        context.tui.removeChild(selector);
        context.tui.setFocus(context.editor);
        if (level && THINKING_LEVELS.includes(level as ThinkingLevel)) {
          context.setThinkingLevel(level as ThinkingLevel);
          addTranscript(context, new Text(colors.green(`Thinking level: ${level}`), 2, 0));
          updateModelStatus(context);
        }
        context.tui.requestRender();
        resolve();
      };
      selector.onSelect = (item) => finish(item.value);
      selector.onCancel = () => finish();
    });
    return;
  }

  const normalized = thinkingArgument.toLowerCase() as ThinkingLevel;
  if (!THINKING_LEVELS.includes(normalized)) {
    addTranscript(
      context,
      new Text(`${colors.red("error")} Unknown thinking level: ${thinkingArgument}`, 2, 0),
    );
    return;
  }

  context.setThinkingLevel(normalized);
  addTranscript(context, new Text(colors.green(`Thinking level: ${normalized}`), 2, 0));
  updateModelStatus(context);
}

async function handleMcpCommand(argument: string | undefined, context: SubmitContext): Promise<void> {
  try {
    const [action = "list", name, ...args] = parseMcpCommandArguments(argument ?? "");
    let result: unknown;
    switch (action) {
      case "list": result = context.mcpService.list(); break;
      case "add":
      case "add-stdio": {
        const [command, ...commandArgs] = args;
        if (!name || !command) {
          throw new Error("用法：/mcp add <name> <command> [args...]，例如 /mcp add source-coop uvx source-coop-mcp");
        }
        if (context.mcpService.list().some((server) => server.name === name)) {
          throw new Error(`MCP 服务 ${name} 已存在；请先移除，避免覆盖现有配置。`);
        }
        await context.mcpService.upsert({
          name, transport: "stdio", command, args: commandArgs, enabled: true,
        });
        addTranscript(context, new Text(`已注册 MCP 服务 ${name}，正在连接并发现工具…`, 2, 0));
        try {
          result = { server: await context.mcpService.connect(name), tools: await context.mcpService.listTools(name) };
        } catch (error) {
          throw new Error(`MCP 服务 ${name} 已保存，但连接失败：${error instanceof Error ? error.message : String(error)}。检查启动命令和网络后可运行 /mcp test ${name} 重试。`);
        }
        break;
      }
      case "add-http": {
        const [url] = args;
        if (!name || !url || args.length !== 1) {
          throw new Error("用法：/mcp add-http <name> <url>");
        }
        if (context.mcpService.list().some((server) => server.name === name)) {
          throw new Error(`MCP 服务 ${name} 已存在；请先移除，避免覆盖现有配置。`);
        }
        await context.mcpService.upsert({ name, transport: "http", url, enabled: true });
        addTranscript(context, new Text(`已注册 MCP 服务 ${name}，正在连接并发现工具…`, 2, 0));
        try {
          result = { server: await context.mcpService.connect(name), tools: await context.mcpService.listTools(name) };
        } catch (error) {
          throw new Error(`MCP 服务 ${name} 已保存，但连接失败：${error instanceof Error ? error.message : String(error)}。检查地址后可运行 /mcp test ${name} 重试。`);
        }
        break;
      }
      case "test":
      case "connect":
        if (!name) throw new Error("用法：/mcp test <name>");
        result = { server: await context.mcpService.connect(name), tools: await context.mcpService.listTools(name) };
        break;
      case "tools":
        if (!name) throw new Error("用法：/mcp tools <name>");
        result = await context.mcpService.listTools(name);
        break;
      case "enable":
      case "disable":
        if (!name) throw new Error(`用法：/mcp ${action} <name>`);
        result = await context.mcpService.setEnabled(name, action === "enable");
        break;
      case "remove":
        if (!name) throw new Error("用法：/mcp remove <name>");
        result = { removed: await context.mcpService.remove(name) };
        break;
      default:
        throw new Error("用法：/mcp [list|add <name> <command> [args...]|add-http <name> <url>|test <name>|tools <name>|enable <name>|disable <name>|remove <name>]");
    }
    addTranscript(context, new Text(JSON.stringify(result, null, 2), 2, 0));
  } catch (error) {
    addTranscript(context, new Text(colors.red(error instanceof Error ? error.message : String(error)), 2, 0));
  }
}

function parseMcpCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error("MCP 命令的引号未闭合。");
  if (started) args.push(current);
  return args;
}

async function handleQgisCommand(
  qgisArgument: string | undefined,
  context: SubmitContext,
): Promise<void> {
  const argument = qgisArgument?.trim();
  const [action, ...rest] = argument?.split(/\s+/u) ?? [];
  const normalizedAction = action?.toLowerCase();

  if (normalizedAction === "clear") {
    clearConfiguredQgisRuntime();
    context.setQgisRuntime(undefined);
    addTranscript(context, new Text(colors.green("QGIS runtime configuration cleared."), 2, 0));
    return;
  }

  if (normalizedAction === "setup") {
    await runQgisSetupFlow(context);
    return;
  }

  if (normalizedAction === "list") {
    if (!requireQgisRuntimeMessage(context)) return;
    const filter = rest.join(" ").trim() || undefined;
    await handleQgisListCommand(filter, context);
    return;
  }

  if (normalizedAction === "info") {
    if (!requireQgisRuntimeMessage(context)) return;
    const algorithmId = rest.join(" ").trim();
    if (!algorithmId) {
      addTranscript(
        context,
        new Text(`${colors.yellow("usage")}  /qgis info <algorithm-id>`, 2, 0),
      );
      return;
    }
    await handleQgisInfoCommand(algorithmId, context);
    return;
  }

  if (normalizedAction === "use") {
    const path = rest.join(" ").trim();
    if (!path) {
      addTranscript(
        context,
        new Text(`${colors.yellow("usage")}  /qgis use <path-to-qgis_process>`, 2, 0),
      );
      return;
    }
    await configureQgisPath(path, context);
    return;
  }

  if (normalizedAction && normalizedAction !== "detect") {
    addTranscript(
      context,
      new Text(
        `${colors.yellow("usage")}  /qgis [setup|detect|list [filter]|info <algo>|use <path>|clear]`,
        2,
        0,
      ),
    );
    return;
  }

  if (!normalizedAction && context.qgisRuntime) {
    addTranscript(context, createQgisStatusMessage(context.qgisRuntime));
    return;
  }

  const candidates = await findQgisCandidates();
  if (candidates.length === 0) {
    await runQgisSetupFlow(context);
    return;
  }

  if (candidates.length === 1) {
    await configureQgisPath(candidates[0]!, context);
    return;
  }

  const selected = await selectQgisCandidate(context, candidates);
  if (selected) {
    await configureQgisPath(selected, context);
  } else {
    addTranscript(context, new Text(colors.dim("QGIS selection cancelled."), 2, 0));
  }
}

type QgisSetupContext = TranscriptContext & Pick<SubmitContext, "setQgisRuntime">;

type QgisSetupAction = "install" | "configure" | "docker" | "remote" | "skip";

const MANUAL_QGIS_PATH_OPTION = "__manual__";

const QGIS_SETUP_OPTIONS: Array<{
  action: QgisSetupAction;
  label: string;
  description: string;
}> = [
  {
    action: "install",
    label: "Install QGIS LTR locally (recommended)",
    description: "Open the QGIS long-term release download page",
  },
  {
    action: "configure",
    label: "Configure existing QGIS path",
    description: "Pick a detected installation or enter a qgis_process path",
  },
  {
    action: "docker",
    label: "Use Docker runtime",
    description: "Run qgis_process in a container (planned)",
  },
  {
    action: "remote",
    label: "Connect remote QGIS runner",
    description: "Use a remote QGIS processing service (planned)",
  },
  {
    action: "skip",
    label: "Continue without QGIS",
    description: "Skip setup; spatial analysis tools stay disabled",
  },
];

async function runQgisSetupFlow(context: QgisSetupContext): Promise<void> {
  const action = await selectQgisSetupAction(context);

  if (!action || action === "skip") {
    addTranscript(
      context,
      new Text(
        colors.dim("Continuing without QGIS. Spatial analysis tools stay disabled."),
        2,
        0,
      ),
    );
    return;
  }

  if (action === "install") {
    showQgisInstallInstructions(context);
    return;
  }

  if (action === "docker" || action === "remote") {
    showQgisRuntimeComingSoon(context, action);
    return;
  }

  const path = await promptQgisConfigurePath(context);
  if (!path) {
    addTranscript(context, new Text(colors.dim("QGIS setup cancelled."), 2, 0));
    return;
  }
  await configureQgisPath(path, context);
}

async function selectQgisSetupAction(
  context: QgisSetupContext,
): Promise<QgisSetupAction | undefined> {
  const selector = new SelectList(
    QGIS_SETUP_OPTIONS.map((option) => ({
      value: option.action,
      label: option.label,
      description: option.description,
    })),
    QGIS_SETUP_OPTIONS.length,
    editorTheme.selectList,
  );
  const selectorIndex = context.tui.children.indexOf(context.editor);
  const titleComponent = new Text(
    [
      colors.yellow("  QGIS runtime not found. Spatial analysis tools are disabled."),
      "",
      colors.cyan("  Choose how to enable QGIS processing:"),
    ].join("\n"),
    2,
    0,
  );
  context.tui.children.splice(selectorIndex, 0, titleComponent);
  context.tui.children.splice(selectorIndex + 1, 0, selector);
  context.tui.setFocus(selector);
  context.tui.requestRender();

  return new Promise<QgisSetupAction | undefined>((resolvePromise) => {
    const finish = (value: QgisSetupAction | undefined): void => {
      context.tui.removeChild(titleComponent);
      context.tui.removeChild(selector);
      context.tui.setFocus(context.editor);
      context.tui.requestRender();
      resolvePromise(value);
    };

    selector.onSelect = (item) => finish(item.value as QgisSetupAction);
    selector.onCancel = () => finish(undefined);
  });
}

function showQgisInstallInstructions(context: QgisSetupContext): void {
  const opened = openInBrowser(QGIS_LTR_DOWNLOAD_URL);
  addTranscript(
    context,
    new Text(
      [
        colors.cyan("Install QGIS LTR"),
        "  1. Download the QGIS long-term release installer:",
        colors.dim(`     ${QGIS_LTR_DOWNLOAD_URL}`),
        "  2. Install with the default options (qgis_process is included).",
        "  3. Restart CityBrain, or run /qgis to detect the new installation.",
        opened
          ? colors.dim("  The download page was opened in your browser.")
          : colors.yellow("  Could not open a browser; open the URL above manually."),
      ].join("\n"),
      2,
      0,
    ),
  );
}

function showQgisRuntimeComingSoon(
  context: QgisSetupContext,
  action: "docker" | "remote",
): void {
  const title = action === "docker"
    ? "Docker QGIS runtime is not available yet"
    : "Remote QGIS runner is not available yet";
  const detail = action === "docker"
    ? [
        colors.dim("  Planned: run qgis_process inside the official qgis/qgis container image."),
        colors.dim("  For now, install QGIS locally or configure an existing path (/qgis)."),
      ]
    : [
        colors.dim("  Planned: connect to a remote machine that exposes qgis_process."),
        colors.dim("  For now, install QGIS locally or configure an existing path (/qgis)."),
      ];
  addTranscript(
    context,
    new Text([colors.yellow(title), ...detail].join("\n"), 2, 0),
  );
}

async function promptQgisConfigurePath(
  context: QgisSetupContext,
): Promise<string | undefined> {
  const candidates = await findQgisCandidates();
  if (candidates.length === 0) {
    return promptQgisPathInput(context);
  }

  const selected = await selectQgisConfigureSource(context, candidates);
  if (!selected) return undefined;
  if (selected === MANUAL_QGIS_PATH_OPTION) return promptQgisPathInput(context);
  return selected;
}

async function selectQgisConfigureSource(
  context: QgisSetupContext,
  candidates: string[],
): Promise<string | undefined> {
  const selector = new SelectList(
    [
      ...candidates.map((path) => ({
        value: path,
        label: path,
        description: "Detected qgis_process entry",
      })),
      {
        value: MANUAL_QGIS_PATH_OPTION,
        label: "Enter path manually...",
        description: "Type the full path to qgis_process",
      },
    ],
    Math.min(candidates.length + 1, 8),
    editorTheme.selectList,
  );
  const selectorIndex = context.tui.children.indexOf(context.editor);
  const titleComponent = new Text(
    colors.cyan("  Select an existing QGIS installation"),
    2,
    0,
  );
  context.tui.children.splice(selectorIndex, 0, titleComponent);
  context.tui.children.splice(selectorIndex + 1, 0, selector);
  context.tui.setFocus(selector);
  context.tui.requestRender();

  return new Promise<string | undefined>((resolvePromise) => {
    const finish = (value: string | undefined): void => {
      context.tui.removeChild(titleComponent);
      context.tui.removeChild(selector);
      context.tui.setFocus(context.editor);
      context.tui.requestRender();
      resolvePromise(value);
    };

    selector.onSelect = (item) => finish(item.value);
    selector.onCancel = () => finish(undefined);
  });
}

async function promptQgisPathInput(
  context: QgisSetupContext,
): Promise<string | undefined> {
  const dialog = new PathInputDialog(
    context.tui,
    "Configure QGIS path",
    colors.cyan,
    colors.dim,
    [
      "Full path to qgis_process or its .bat wrapper, for example",
      "  C:\\Program Files\\QGIS 3.40.4 LTR\\bin\\qgis_process-qgis-ltr.bat",
    ],
  );
  const editorIndex = context.tui.children.indexOf(context.editor);
  context.tui.children.splice(editorIndex, 0, dialog);
  context.tui.setFocus(dialog);
  context.tui.requestRender();

  const path = await dialog.open();
  context.tui.removeChild(dialog);
  context.tui.setFocus(context.editor);
  context.tui.requestRender();

  const cleaned = path?.trim().replace(/^(["'])(.*)\1$/u, "$2");
  return cleaned || undefined;
}

function requireQgisRuntimeMessage(context: SubmitContext): boolean {
  if (context.qgisRuntime) return true;
  addTranscript(
    context,
    new Text(
      [
        colors.yellow("QGIS runtime is not configured."),
        colors.dim("  Run /qgis to set it up, or /qgis use <path>."),
      ].join("\n"),
      2,
      0,
    ),
  );
  return false;
}

async function handleQgisListCommand(
  filter: string | undefined,
  context: SubmitContext,
): Promise<void> {
  const selectorIndex = context.tui.children.indexOf(context.editor);
  const progress = new Text(
    colors.dim(`  Searching QGIS algorithms${filter ? ` for "${filter}"` : ""}...`),
    2,
    0,
  );
  context.tui.children.splice(selectorIndex, 0, progress);
  context.tui.requestRender();

  try {
    const result = await listQgisAlgorithms(context.qgisRuntime!, filter);
    const lines = result.algorithms.map((algorithm) =>
      `  ${algorithm.id}  ${colors.dim(algorithm.name)}`,
    );
    const header = colors.green(
      `QGIS algorithms: matched ${result.matched} of ${result.total}, showing ${result.algorithms.length}`,
    );
    const notice = result.truncated
      ? colors.dim("  [List truncated - refine the filter keyword.]")
      : "";
    const body = [header, ...lines, notice].filter(Boolean).join("\n");
    progress.setText(body);
  } catch (error) {
    progress.setText(
      `${colors.red("qgis_process failed")}  ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  context.tui.requestRender();
}

async function handleQgisInfoCommand(
  algorithmId: string,
  context: SubmitContext,
): Promise<void> {
  const selectorIndex = context.tui.children.indexOf(context.editor);
  const progress = new Text(
    colors.dim(`  Loading ${algorithmId}...`),
    2,
    0,
  );
  context.tui.children.splice(selectorIndex, 0, progress);
  context.tui.requestRender();

  try {
    const helpText = await describeQgisAlgorithm(context.qgisRuntime!, algorithmId);
    progress.setText(
      [colors.green(algorithmId), indentBlock(helpText)].join("\n"),
    );
  } catch (error) {
    progress.setText(
      `${colors.red("qgis_process failed")}  ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  context.tui.requestRender();
}

function indentBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

async function configureQgisPath(
  path: string,
  context: QgisSetupContext,
): Promise<void> {
  try {
    const runtime = await configureQgisRuntime(path);
    context.setQgisRuntime(runtime);
    addTranscript(context, createQgisStatusMessage(runtime));
  } catch (error) {
    addTranscript(
      context,
      new Text(
        `${colors.red("QGIS configuration failed")}  ${error instanceof Error ? error.message : String(error)}`,
        2,
        0,
      ),
    );
  }
}

async function selectQgisCandidate(
  context: SubmitContext,
  candidates: string[],
): Promise<string | undefined> {
  const selector = new SelectList(
    candidates.map((path) => ({
      value: path,
      label: path,
      description: "Existing qgis_process entry",
    })),
    8,
    editorTheme.selectList,
  );
  const selectorIndex = context.tui.children.indexOf(context.editor);
  const titleComponent = new Text(colors.cyan("  Select an existing QGIS installation"), 2, 0);
  context.tui.children.splice(selectorIndex, 0, titleComponent);
  context.tui.children.splice(selectorIndex + 1, 0, selector);
  context.tui.setFocus(selector);
  context.tui.requestRender();

  return new Promise<string | undefined>((resolvePromise) => {
    const finish = (value: string | undefined): void => {
      context.tui.removeChild(titleComponent);
      context.tui.removeChild(selector);
      context.tui.setFocus(context.editor);
      context.tui.requestRender();
      resolvePromise(value);
    };

    selector.onSelect = (item) => finish(item.value);
    selector.onCancel = () => finish(undefined);
  });
}

async function selectModel(
  context: SubmitContext,
  models: ModelDefinition[],
): Promise<ModelDefinition | undefined> {
  const selector = new SelectList(
    models.map((model) => ({
      value: getModelReference(model),
      label: `${context.modelRuntime.getProviderLabel(model.provider)} / ${model.id}`,
      description: model.description,
    })),
    8,
    editorTheme.selectList,
  );
  const selectorIndex = context.tui.children.indexOf(context.editor);
  const titleComponent = new Text(colors.cyan("  Select an active model"), 2, 0);
  context.tui.children.splice(selectorIndex, 0, titleComponent);
  context.tui.children.splice(selectorIndex + 1, 0, selector);
  context.tui.setFocus(selector);
  context.tui.requestRender();

  return new Promise<ModelDefinition | undefined>((resolve) => {
    const finish = (value: ModelDefinition | undefined): void => {
      context.tui.removeChild(titleComponent);
      context.tui.removeChild(selector);
      context.tui.setFocus(context.editor);
      context.tui.requestRender();
      resolve(value);
    };

    selector.onSelect = (item) => {
      finish(models.find((model) => getModelReference(model) === item.value));
    };
    selector.onCancel = () => finish(undefined);
  });
}

function updateModelStatus(
  context: Pick<SubmitContext, "modelRuntime" | "modelStatus" | "tui" | "thinkingLevel"> & {
    session?: SessionManager;
  },
): void {
  const selected = context.modelRuntime.getSelectedModel();
  const usage = selected && context.session
    ? context.session.getContextUsage(selected.contextWindow ?? DEFAULT_CONTEXT_WINDOW)
    : undefined;
  const totals = context.session?.getUsageTotals();

  if (!selected) {
    context.modelStatus.setParts(
      colors.dim("model not configured  |  /login to connect a provider"),
      "",
    );
    context.tui.requestRender();
    return;
  }

  const inputTokens =
    (totals?.input ?? 0) + (totals?.cacheRead ?? 0) + (totals?.cacheWrite ?? 0);
  const outputTokens = totals?.output ?? 0;
  const usageText = usage
    ? `${usage.percent.toFixed(1)}%/${formatTokenCount(usage.contextWindow)} (${usage.estimated ? "estimated" : "provider"})`
    : `0.0%/${formatTokenCount(selected.contextWindow ?? DEFAULT_CONTEXT_WINDOW)}`;
  context.modelStatus.setParts(
    [
      colors.dim(`↑${formatTokenCount(inputTokens)}`),
      colors.dim(`↓${formatTokenCount(outputTokens)}`),
      colors.dim("$0.000"),
      colors.dim(`${usageText} (auto)`),
    ].join(" "),
    `${colors.cyan(selected.id)} ${colors.dim(`• ${THINKING_LEVEL}`)}`,
  );
  context.tui.requestRender();
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatContextUsage(snapshot: ContextUsageSnapshot): string {
  const marker = snapshot.estimated ? "~" : "=";
  const source = snapshot.source === "provider_usage_plus_estimate"
    ? "provider+estimate"
    : snapshot.estimated
      ? "estimated"
      : "provider";
  const windowSource = snapshot.contextWindowSource === "model_metadata"
    ? "limit:model"
    : "limit:fallback";
  return [
    `context ${marker}${formatTokenCount(snapshot.contextTokens)}/${formatTokenCount(snapshot.contextWindow)}`,
    `${snapshot.percent.toFixed(1)}%`,
    source,
    windowSource,
  ].join(" ");
}

function createMarkdownTheme(): MarkdownTheme {
  return {
    heading: colors.cyan,
    link: (text) => text,
    linkUrl: colors.dim,
    code: colors.yellow,
    codeBlock: (text) => text,
    codeBlockBorder: colors.dim,
    quote: colors.dim,
    quoteBorder: colors.dim,
    hr: colors.dim,
    listBullet: colors.cyan,
    bold: (text) => text,
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => text,
  };
}

function getThinkingBorderColor(level: ThinkingLevel): (text: string) => string {
  if (level === "max") {
    return (text) => styleText(["magenta", "bold"], text);
  }
  if (level === "high") {
    return (text) => styleText("magenta", text);
  }
  return colors.dim;
}

// Tool results are rendered as a compact header only - the full returned
// content (algorithm schemas, catalog listings) is too large to show in the
// CLI. Failures keep a single truncated reason line for diagnosis.
const TOOL_ERROR_LINE_CHARS = 160;

function createToolRunningMessage(event: ToolExecutionStarted): string {
  const target = getToolTarget(event.argumentsText);
  const summary = event.toolUseSummary ?? target;
  if (event.activityDescription) {
    return summary
      ? `${event.activityDescription}: ${summary}`
      : event.activityDescription;
  }
  if (event.name === "read_file") {
    return target ? `Reading file: ${target}` : "Reading file...";
  }
  return summary ? `Running ${event.name}: ${summary}` : `Running ${event.name}...`;
}

function createToolProgressMessage(name: string, progress: ToolProgress): string {
  const phase =
    progress.phase === "verifying_outputs"
      ? "verifying outputs"
      : progress.phase === "running"
        ? "running"
        : progress.phase;
  const elapsed = progress.elapsedMs
    ? `  ${Math.floor(progress.elapsedMs / 1000)}s`
    : "";
  const detail = progress.message ? `  ${truncateSingleLine(progress.message, 120)}` : "";
  return `${colors.dim(`${name} ${phase}${elapsed}`)}${detail}`;
}

function createToolLifecycleMessage(
  lifecycle: Extract<AgentEvent, { type: "tool_lifecycle" }>["lifecycle"],
): string {
  const labels: Record<string, string> = {
    tool_resolved: "resolved",
    tool_validating: "validating input",
    tool_normalizing: "normalizing input",
    tool_normalized: "input normalized",
    pre_tool_hook: "pre-tool hook",
    sandbox_check: "checking sandbox",
    policy_check: "checking policy",
    permission_decision: "permission decision",
    tool_artifact_preflight: "checking artifacts",
    tool_queued: "queued",
    tool_started: "started",
    tool_completed: "completed",
    post_tool_hook: "post-tool hook",
    failure_hook: "failure hook",
    tool_failed: "failed",
  };
  const label = labels[lifecycle.stage] ?? lifecycle.stage;
  const detail = lifecycle.detail
    ? `  ${truncateSingleLine(lifecycle.detail, 120)}`
    : "";
  return `${colors.dim(label)}${detail}`;
}

function createToolDisplayText(event: ToolExecutionResult): string {
  const target = getToolTarget(event.argumentsText);
  const header = createToolHeader(event.name, target, event.toolUseSummary);
  // Success: header only. Failure: header + one truncated reason line.
  const firstLine = event.result.replace(/^Tool error:\s*/i, "").split("\n")[0]?.trim();
  if (event.ok || !firstLine) return header;
  return `${header}\n${colors.toolErrorText(truncateSingleLine(firstLine, TOOL_ERROR_LINE_CHARS))}`;
}

function createToolHeader(name: string, target: string, summary?: string): string {
  const displayName = name === "read_file" ? "read" : name;
  const detail = summary || target;
  if (!detail) return colors.toolTitle(displayName);
  return `${colors.toolTitle(displayName)} ${colors.toolPath(detail)}`;
}

function createToolResultComponent(event: ToolExecutionResult): Box {
  const box = new Box(
    1,
    1,
    event.ok ? colors.toolSuccessBackground : colors.toolErrorBackground,
  );
  box.addChild(new Text(createToolDisplayText(event), 0, 0));
  return box;
}

function createToolRunningComponent(segment: ToolSegment): Box {
  const box = new Box(
    1,
    1,
    colors.toolSuccessBackground,
  );
  const target = getToolTarget(segment.event.argumentsText);
  const header = createToolHeader(
    segment.event.name,
    target,
    segment.event.toolUseSummary,
  );
  box.addChild(
    new Text(
      `${header}\n${colors.dim(segment.status || "running")}`,
      0,
      0,
    ),
  );
  return box;
}

/** One subagent's status, formatted as a single dim footer line. */
function formatAgentStatusLine(agent: AgentStatusUpdate): string {
  const name = colors.agentTitle(agent.agent);
  const status = renderAgentStatus(agent);
  const tokenLine = agent.usage ? "  " + formatAgentUsage(agent.usage) : "";
  return `${name}${status}${tokenLine}`;
}

function formatHarnessStatus(state: AgentHarnessStateUpdate): string {
  switch (state.state) {
    case "streaming_model":
      return state.reason === "requesting final answer without tools"
        ? "Preparing final answer..."
        : "Thinking...";
    case "waiting_for_tools":
      return state.reason ? `Waiting for ${state.reason}` : "Waiting for tools...";
    case "executing_tools":
      return "Executing tools...";
    case "finalizing":
      return state.reason
        ? `Finalizing safely: ${state.reason}`
        : "Finalizing safely...";
    case "failed":
    case "aborted":
      return `${state.state}: ${state.reason ?? "run stopped"}`;
    case "completed":
      return "";
    default:
      return "";
  }
}

function formatHarnessErrorStatus(error: HarnessError): string {
  return [
    colors.red(`harness ${error.category}`),
    truncateSingleLine(error.message, 140),
    colors.dim(`recovery=${error.recovery}`),
  ].join("  ");
}

function renderAgentStatus(agent: AgentStatusUpdate): string {
  if (agent.status === "running") {
    return colors.agentRunningText(" ● 进行中");
  }
  if (agent.status === "completed") {
    return colors.agentDoneText(" ✓ 完成");
  }
  const error = agent.error ? ` — ${truncateSingleLine(agent.error, TOOL_ERROR_LINE_CHARS)}` : "";
  return colors.agentErrorText(` ✗ 失败${error}`);
}

function formatAgentUsage(usage: ModelUsage): string {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return [
    colors.dim(`↑${formatTokenCount(input)}`),
    colors.dim(`↓${formatTokenCount(usage.output)}`),
    colors.dim("$0.000"),
  ].join(" ");
}

function getToolTarget(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (isPlainObject(parsed) && typeof parsed.path === "string") {
      return truncateSingleLine(parsed.path, 80);
    }
    return truncateSingleLine(JSON.stringify(parsed), 80);
  } catch {
    return truncateSingleLine(argumentsText, 80);
  }
}

function getSinglePath(args: unknown): string | undefined {
  if (
    isPlainObject(args) &&
    typeof args.path === "string" &&
    args.path.trim()
  ) {
    return args.path.trim();
  }
  return undefined;
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AssistantResponseComponent extends Container {
  private segments: ResponseSegment[] = [];
  private error = "";
  private isStreaming = false;
  private showThinking = true;
  private harnessStatus = "";
  private contextUsage = "";
  private readonly toolsById = new Map<string, ToolSegment>();

  setContent(
    thinking: string,
    response: string,
    isStreaming: boolean,
    showThinking = true,
  ): void {
    this.segments = [{
      kind: "assistant",
      thinking,
      response,
      closed: false,
    }];
    this.toolsById.clear();
    this.error = "";
    this.isStreaming = isStreaming;
    this.showThinking = showThinking;
    this.rebuild();
  }

  appendThinking(delta: string): void {
    const segment = this.ensureAssistantSegment();
    segment.thinking += delta;
    this.isStreaming = true;
    this.rebuild();
  }

  appendText(delta: string): void {
    const segment = this.ensureAssistantSegment();
    segment.response += delta;
    this.isStreaming = true;
    this.rebuild();
  }

  startTool(event: ToolExecutionStarted): void {
    const current = this.segments.at(-1);
    if (current?.kind === "assistant") current.closed = true;
    const segment: ToolSegment = {
      kind: "tool",
      event: {
        name: event.name,
        argumentsText: event.argumentsText,
        taskId: event.taskId,
        toolCallId: event.toolCallId,
        ok: false,
        result: "",
      },
      status: createToolRunningMessage(event),
      completed: false,
    };
    this.segments.push(segment);
    this.toolsById.set(event.toolCallId ?? `${event.name}:${this.segments.length}`, segment);
    this.rebuild();
  }

  updateToolProgress(event: Extract<AgentEvent, { type: "tool_progress" }>): void {
    const segment = this.findToolSegment(event.toolCallId);
    if (segment) {
      segment.status = createToolProgressMessage(event.name, event.progress);
    }
    this.rebuild();
  }

  updateToolLifecycle(event: Extract<AgentEvent, { type: "tool_lifecycle" }>): void {
    const segment = this.findToolSegment(event.toolCallId);
    if (segment) {
      segment.status = createToolLifecycleMessage(event.lifecycle);
    }
    this.rebuild();
  }

  completeTool(result: ToolExecutionResult): void {
    const segment = this.findToolSegment(result.toolCallId);
    if (segment) {
      segment.event = result;
      segment.completed = true;
      segment.status = "";
    } else {
      this.segments.push({
        kind: "tool",
        event: result,
        status: "",
        completed: true,
      });
    }
    this.rebuild();
  }

  setHarnessStatus(status: string): void {
    this.harnessStatus = status;
    this.rebuild();
  }

  setContextUsage(snapshot: ContextUsageSnapshot): void {
    this.contextUsage = formatContextUsage(snapshot);
    this.rebuild();
  }

  setCompleted(): void {
    this.isStreaming = false;
    this.rebuild();
  }

  setError(error: string): void {
    this.error = error;
    this.isStreaming = false;
    this.rebuild();
  }

  private ensureAssistantSegment(): AssistantSegment {
    const current = this.segments.at(-1);
    if (current?.kind === "assistant" && !current.closed) return current;
    const next: AssistantSegment = {
      kind: "assistant",
      thinking: "",
      response: "",
      closed: false,
    };
    this.segments.push(next);
    return next;
  }

  private findToolSegment(toolCallId?: string): ToolSegment | undefined {
    if (toolCallId) return this.toolsById.get(toolCallId);
    return [...this.segments].reverse().find(
      (segment): segment is ToolSegment => segment.kind === "tool" && !segment.completed,
    );
  }

  private rebuild(): void {
    this.clear();

    const lastAssistantIndex = this.segments.reduce(
      (last, segment, index) => segment.kind === "assistant" ? index : last,
      -1,
    );
    for (let index = 0; index < this.segments.length; index += 1) {
      const segment = this.segments[index]!;
      if (segment.kind === "assistant") {
        this.renderAssistantSegment(
          segment,
          index === lastAssistantIndex && !this.segments.slice(index + 1).some(
            (next) => next.kind === "tool",
          ),
        );
      } else {
        this.addChild(
          segment.completed
            ? createToolResultComponent(segment.event)
            : createToolRunningComponent(segment),
        );
      }
      if (index < this.segments.length - 1) this.addChild(new Spacer(1));
    }

    if (this.harnessStatus) {
      this.addChild(new Text(colors.dim(this.harnessStatus), 2, 0));
    }

    if (this.contextUsage) {
      this.addChild(new Text(colors.dim(this.contextUsage), 2, 0));
    }

    if (this.error) {
      this.addChild(new Text(`${colors.red("citybrain error")}\n\n${this.error}`, 2, 1));
    } else if (
      this.isStreaming &&
      !this.segments.some((segment) =>
        segment.kind === "assistant" && (segment.thinking.trim() || segment.response.trim()),
      )
    ) {
      this.addChild(new Text(colors.thinkingText("Thinking..."), 2, 0));
    }
  }

  private renderAssistantSegment(
    segment: AssistantSegment,
    isFinalResponse: boolean,
  ): void {
    if (this.showThinking && segment.thinking.trim()) {
      this.addChild(
        new Markdown(
          segment.thinking.trim(),
          2,
          0,
          createMarkdownTheme(),
          {
            color: colors.thinkingText,
            italic: true,
          },
        ),
      );
      if (segment.response.trim()) this.addChild(new Spacer(1));
    }

    if (segment.response.trim()) {
      const heading = isFinalResponse ? `${colors.green("citybrain")}\n\n` : "";
      this.addChild(
        new Markdown(
          `${heading}${segment.response.trim()}`,
          2,
          1,
          createMarkdownTheme(),
        ),
      );
    }
  }
}

interface AssistantSegment {
  kind: "assistant";
  thinking: string;
  response: string;
  closed: boolean;
}

interface ToolSegment {
  kind: "tool";
  event: ToolExecutionResult;
  status: string;
  completed: boolean;
}

type ResponseSegment = AssistantSegment | ToolSegment;

interface SessionSelectItem {
  value: string;
  label: string;
  description: string;
  active: boolean;
}

class SessionSelectList implements Component {
  onSelect?: (item: SessionSelectItem) => void;
  onCancel?: () => void;
  private selectedIndex: number;

  constructor(
    private readonly items: SessionSelectItem[],
    private readonly maxVisible = 8,
  ) {
    const firstInactive = items.findIndex((item) => !item.active);
    this.selectedIndex = firstInactive >= 0 ? firstInactive : 0;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.items.length === 0) return;

    if (matchesKey(data, "up")) {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      return;
    }

    if (matchesKey(data, "down")) {
      this.selectedIndex =
        this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      return;
    }

    if (matchesKey(data, "enter")) {
      const item = this.items[this.selectedIndex];
      if (item) this.onSelect?.(item);
      return;
    }

    if (matchesKey(data, "escape")) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    if (this.items.length === 0) {
      return [colors.dim("  No sessions")];
    }

    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    const { startIndex, endIndex } = this.getVisibleRange();
    const primaryWidth = this.getPrimaryWidth(safeWidth);

    for (let index = startIndex; index < endIndex; index++) {
      const item = this.items[index];
      if (!item) continue;
      lines.push(this.renderItem(item, index === this.selectedIndex, safeWidth, primaryWidth));
    }

    if (startIndex > 0 || endIndex < this.items.length) {
      lines.push(colors.dim(`  (${this.selectedIndex + 1}/${this.items.length})`));
    }

    return lines;
  }

  private renderItem(
    item: SessionSelectItem,
    selected: boolean,
    width: number,
    primaryWidth: number,
  ): string {
    const prefix = selected ? "> " : "  ";
    const prefixWidth = visibleWidth(prefix);
    let line: string;

    if (width > 54) {
      const label = truncateToWidth(item.label, primaryWidth, "");
      const spacing = " ".repeat(Math.max(1, primaryWidth - visibleWidth(label) + 2));
      const remaining = Math.max(1, width - prefixWidth - visibleWidth(label) - spacing.length);
      const description = truncateToWidth(item.description, remaining, "");
      line = `${prefix}${label}${spacing}${description}`;
    } else {
      line = `${prefix}${truncateToWidth(item.label, Math.max(1, width - prefixWidth), "")}`;
    }

    const clipped = truncateToWidth(line, width, "");
    if (selected) return colors.white(clipped);
    if (item.active) return colors.yellow(clipped);
    return colors.dim(clipped);
  }

  private getVisibleRange(): { startIndex: number; endIndex: number } {
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.items.length - this.maxVisible,
      ),
    );
    return {
      startIndex,
      endIndex: Math.min(startIndex + this.maxVisible, this.items.length),
    };
  }

  private getPrimaryWidth(width: number): number {
    const widestLabel = this.items.reduce(
      (widest, item) => Math.max(widest, visibleWidth(item.label)),
      0,
    );
    return Math.max(24, Math.min(widestLabel, Math.min(58, Math.floor(width * 0.62))));
  }
}

/**
 * Dedicated footer area below the input box that renders each delegated
 * subagent as its own live status line (name + token accounting + colored
 * status). Updates are keyed by agent name, so repeated `running` emissions
 * with growing usage overwrite the same line instead of stacking.
 */
class AgentStatusFooter implements Component {
  private readonly agents = new Map<string, AgentStatusUpdate>();

  setStatus(update: AgentStatusUpdate): void {
    this.agents.set(update.agent, update);
  }

  clear(): void {
    this.agents.clear();
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.agents.size === 0) return [];
    const innerWidth = Math.max(1, width - 1);
    return [...this.agents.values()].map((agent) =>
      ` ${truncateToWidth(formatAgentStatusLine(agent), innerWidth, "")}`,
    );
  }
}

/** Persistent bottom line showing the active CityBrain workspace. */
class SandboxStatus implements Component {
  private path = "";

  setPath(path: string): void {
    this.path = path;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.path) return [];
    const innerWidth = Math.max(1, width - 1);
    return [
      ` ${truncateToWidth(`${colors.cyan("workspace")}  ${colors.dim(this.path)}`, innerWidth, "")}`,
    ];
  }
}

class FooterStatus implements Component {
  private left = "";
  private right = "";
  private context = "";

  setParts(left: string, right: string): void {
    this.left = left;
    this.right = right;
    this.context = "";
  }

  setContextUsage(snapshot: ContextUsageSnapshot): void {
    this.context = formatContextUsage(snapshot);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const innerWidth = Math.max(1, safeWidth - 2);
    const leftWidth = visibleWidth(this.left);
    const rightWidth = visibleWidth(this.right);

    const middle = this.context ? `  ${this.context}` : "";
    const middleWidth = visibleWidth(middle);
    const totalWidth = leftWidth + middleWidth + rightWidth;

    if (!this.right || totalWidth + 2 > innerWidth) {
      const compactLeft = this.context
        ? `${this.left}${middle}`
        : this.left;
      return [` ${truncateToWidth(compactLeft, innerWidth, "")}`];
    }

    const gap = " ".repeat(Math.max(1, innerWidth - totalWidth));
    return [` ${this.left}${middle}${gap}${this.right}`];
  }
}
