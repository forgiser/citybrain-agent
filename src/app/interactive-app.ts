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
import { join } from "node:path";
import { styleText } from "node:util";
import { AgentLoop } from "../agent/agent-loop.js";
import type {
  ToolExecutionResult,
  ToolExecutionStarted,
  ToolProgress,
} from "../agent/agent-loop.js";
import type { AgentStatusUpdate } from "../agent/agent-status.js";
import type { AgentHarnessStateUpdate } from "../agent/agent-state.js";
import type { ContextUsageSnapshot } from "../context/context-usage.js";
import { AuthStorage } from "../auth/auth-storage.js";
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
  detectQgisRuntime,
  findQgisCandidates,
  type QgisRuntimeInfo,
} from "../qgis/qgis-runtime.js";
import { PathInputDialog } from "../qgis/path-input-dialog.js";
import {
  QGIS_LTR_DOWNLOAD_URL,
  openInBrowser,
} from "../qgis/qgis-setup.js";
import {
  describeQgisAlgorithm,
  listQgisAlgorithms,
} from "../qgis/qgis-process-client.js";
import { createQgisTools } from "../qgis/qgis-tools.js";
import {
  executeReadFile,
  readFileToolDefinition,
} from "../tools/read-file.js";
import {
  executeListFiles,
  listFilesToolDefinition,
} from "../tools/list-files.js";
import { createSubagentTool } from "../tools/subagent-tool.js";
import { ContextUsageLogger } from "../context/context-usage-log.js";
import { ContextTraceLogger } from "../context/context-trace-log.js";
import { ToolExecutionLogger } from "../tools/tool-execution-log.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import {
  ensureWorkspace,
  type WorkspaceInfo,
} from "../workspace/workspace.js";
import { findShellCommand, shellCommands } from "./shell-commands.js";

const VERSION = "0.1.0";
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";
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
  toolPath: (text: string) => underline(fgRgb(139, 193, 187, text)),
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

export async function startInteractiveApp(): Promise<void> {
  const authStorage = new AuthStorage();
  const modelRuntime = new ModelRuntime(authStorage);
  let session = SessionManager.create(process.cwd());
  let qgisRuntime = await detectQgisRuntime();
  let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;
  const toolLogger = new ToolExecutionLogger(
    () => join(session.getWorkspaceDir(), ".internal", "tool-execution.jsonl"),
  );
  const contextLogger = new ContextUsageLogger(
    () => join(session.getWorkspaceDir(), ".internal", "context-usage.jsonl"),
  );
  const contextTraceLogger = new ContextTraceLogger(
    () => join(session.getWorkspaceDir(), ".internal", "context-trace.jsonl"),
  );
  const toolRegistry = new ToolRegistry({ logger: toolLogger });
  toolRegistry.register(
    readFileToolDefinition,
    (args, toolContext) => executeReadFile(args, session.getCwd(), toolContext),
    { isConcurrencySafe: () => true },
  );
  toolRegistry.register(
    listFilesToolDefinition,
    (args) => executeListFiles(args, session.getCwd()),
    { isConcurrencySafe: () => true },
  );
  for (const tool of createQgisTools(() => qgisRuntime)) {
    toolRegistry.register(tool.definition, tool.handler, {
      isConcurrencySafe: tool.isConcurrencySafe,
    });
  }
  const delegateTool = createSubagentTool({
    modelRuntime,
    authStorage,
    getCwd: () => session.getCwd(),
    getQgisRuntime: () => qgisRuntime,
    toolLogger,
    contextLogger,
    options: { thinkingLevel },
  });
  toolRegistry.register(delegateTool.definition, delegateTool.handler, {
    isConcurrencySafe: delegateTool.isConcurrencySafe,
  });
  const agentLoop = new AgentLoop(
    modelRuntime,
    authStorage,
    session,
    toolRegistry,
    toolLogger,
    contextLogger,
    contextTraceLogger,
  );
  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiMainScreen(terminal, true);
  const editor = new Editor(tui, editorTheme, {
    paddingX: 1,
    autocompleteMaxVisible: 7,
  });
  editor.borderColor = getThinkingBorderColor(thinkingLevel);
  const transcript: Component[] = [];
  const modelStatus = new FooterStatus();
  const agentStatusFooter = new AgentStatusFooter();
  const sandboxStatus = new SandboxStatus();
  sandboxStatus.setPath(session.getWorkspaceDir());
  const setSession = (nextSession: SessionManager): void => {
    session = nextSession;
    agentLoop.setSession(nextSession);
    sandboxStatus.setPath(nextSession.getWorkspaceDir());
    tui.requestRender();
  };
  const setQgisRuntime = (nextRuntime: QgisRuntimeInfo | undefined): void => {
    qgisRuntime = nextRuntime;
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
    let lastCtrlCAt = 0;
    let ctrlCNotice: Text | undefined;
    let ctrlCNoticeTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
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
      return undefined;
    });

    editor.onSubmit = (value) => {
      void handleSubmit(value, {
        editor,
        agentLoop,
        authStorage,
        modelRuntime,
        modelStatus,
        agentStatusFooter,
        sandboxStatus,
        session,
        setSession,
        setThinkingLevel: (level) => {
          thinkingLevel = level;
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
    };

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
  setSession: (session: SessionManager) => void;
  qgisRuntime: QgisRuntimeInfo | undefined;
  setQgisRuntime: (runtime: QgisRuntimeInfo | undefined) => void;
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
  stop: () => void;
  transcript: Component[];
  tui: TUI;
}

type TranscriptContext = Pick<SubmitContext, "editor" | "transcript" | "tui">;

async function handleSubmit(value: string, context: SubmitContext): Promise<void> {
  const input = value.trim();
  if (!input) return;

  if (input.startsWith("/")) {
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
        context.session.newSession(process.cwd());
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
      case "/init":
        await handleInitCommand(getCommandArgument(input), context);
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
    const info = ensureWorkspace(context.session.getCwd());
    if (info.created.length > 0) {
      addTranscript(context, createWorkspaceMessage(info));
    }
  }

  addTranscript(
    context,
    createUserMessage(input),
  );

  const responseComponent = new AssistantResponseComponent();
  addTranscript(context, responseComponent);
  context.editor.disableSubmit = true;
  context.agentStatusFooter.clear();
  let responseText = "";
  let thinkingText = "";

  try {
    const eventStream = context.agentLoop.run(input, {
      thinkingLevel: context.thinkingLevel,
    });
    for await (const event of eventStream) {
      if (event.type === "text") {
        responseText += event.delta;
        responseComponent.setContent(
          thinkingText,
          responseText,
          true,
        );
        context.tui.requestRender();
        continue;
      }
      if (event.type === "thinking") {
        thinkingText += event.delta;
        responseComponent.setContent(
          thinkingText,
          responseText,
          true,
        );
        context.tui.requestRender();
        continue;
      }
      if (event.type === "tool_started") {
        // delegate is rendered as its own agent status line, not a tool box.
        if (event.name !== "delegate") {
          responseComponent.setToolStatus(
            createToolRunningMessage(event),
          );
        }
        context.tui.requestRender();
        continue;
      }
      if (event.type === "tool_progress") {
        if (event.name !== "delegate") {
          responseComponent.setToolStatus(
            createToolProgressMessage(event.name, event.progress),
          );
        }
        context.tui.requestRender();
        continue;
      }
      if (event.type === "tool_result") {
        responseComponent.setToolStatus("");
        if (event.name !== "delegate") {
          responseComponent.addToolResult(event);
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
    responseComponent.setContent(thinkingText, responseText, false);
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

function createQgisStatusMessage(runtime: QgisRuntimeInfo | undefined): Text {
  if (!runtime) {
    return new Text(
      [
        colors.yellow("QGIS runtime not found. Spatial analysis tools are disabled."),
        colors.dim("  Run /qgis to set up QGIS processing."),
      ].join("\n"),
      2,
      0,
    );
  }

  return new Text(
    [
      colors.green("QGIS processing ready"),
      `  ${runtime.version}`,
      colors.dim(`  ${runtime.executablePath}`),
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
    ? "blank workspace"
    : `${info.messageCount} messages`;
  return new Text(
    [
      color("────────────────────────────────────────────────"),
      `${color(title)}  ${colors.dim(info.id.slice(0, 8))}  ${colors.dim(detail)}${session.isPersisted() ? "" : `  ${colors.dim("(not saved)")}`}`,
      `${colors.dim("sandbox")}  ${colors.dim(session.getWorkspaceDir())}`,
      color("────────────────────────────────────────────────"),
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

function createHeader(): Text {
  const cwd = process.cwd();
  const line = "-".repeat(Math.min(Math.max(cwd.length + 30, 46), 90));

  return new Text(
    [
      `${colors.cyan("  CITYBRAIN")} ${colors.dim("| urban data intelligence")}`,
      colors.dim(`  v${VERSION}  |  ${cwd}`),
      colors.dim(line),
      "",
      colors.white("  City data analysis and governance workspace"),
      colors.dim("  Type / for commands"),
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

const INIT_USE_CURRENT = "__current__";
const INIT_CHOOSE_OTHER = "__choose__";

async function handleInitCommand(
  targetArgument: string | undefined,
  context: SubmitContext,
): Promise<void> {
  if (targetArgument && targetArgument.split(/\s+/).length > 1) {
    addTranscript(
      context,
      new Text(`${colors.yellow("usage")}  /init [<target-folder>]`, 2, 0),
    );
    return;
  }

  let targetDir = targetArgument?.trim();
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
      targetDir = context.session.getCwd();
    }
  }

  try {
    const info = ensureWorkspace(targetDir);
    context.session.setWorkspaceDir(info.workspaceDir);
    context.sandboxStatus.setPath(info.workspaceDir);
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

async function selectInitTarget(context: SubmitContext): Promise<string | undefined> {
  const selector = new SelectList(
    [
      {
        value: INIT_USE_CURRENT,
        label: "当前文件夹（默认）",
        description: context.session.getCwd(),
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
  const sessions = SessionManager.list(process.cwd());

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
  if (event.name === "read_file") {
    return target ? `Reading file: ${target}` : "Reading file...";
  }
  return target ? `Running ${event.name}: ${target}` : `Running ${event.name}...`;
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

function createToolDisplayText(event: ToolExecutionResult): string {
  const target = getToolTarget(event.argumentsText);
  const header = createToolHeader(event.name, target);
  // Success: header only. Failure: header + one truncated reason line.
  const firstLine = event.result.replace(/^Tool error:\s*/i, "").split("\n")[0]?.trim();
  if (event.ok || !firstLine) return header;
  return `${header}\n${colors.toolErrorText(truncateSingleLine(firstLine, TOOL_ERROR_LINE_CHARS))}`;
}

function createToolHeader(name: string, target: string): string {
  const displayName = name === "read_file" ? "read" : name;
  if (!target) return colors.toolTitle(displayName);
  return `${colors.toolTitle(displayName)} ${colors.toolPath(target)}`;
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

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AssistantResponseComponent extends Container {
  private thinking = "";
  private response = "";
  private error = "";
  private isStreaming = false;
  private showThinking = true;
  private toolStatus = "";
  private toolResults: ToolExecutionResult[] = [];
  private harnessStatus = "";
  private contextUsage = "";

  setContent(
    thinking: string,
    response: string,
    isStreaming: boolean,
    showThinking = true,
  ): void {
    this.thinking = thinking;
    this.response = response;
    this.error = "";
    this.isStreaming = isStreaming;
    this.showThinking = showThinking;
    this.rebuild();
  }

  setToolStatus(status: string): void {
    this.toolStatus = status;
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

  addToolResult(result: ToolExecutionResult): void {
    this.toolResults.push(result);
    this.rebuild();
  }

  setError(error: string): void {
    this.error = error;
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();

    if (this.showThinking && this.thinking.trim()) {
      this.addChild(
        new Markdown(
          this.thinking.trim(),
          2,
          0,
          createMarkdownTheme(),
          {
            color: colors.thinkingText,
            italic: true,
          },
        ),
      );
      if (this.response.trim() || this.isStreaming) {
        this.addChild(new Spacer(1));
      }
    } else if (this.isStreaming && !this.response.trim() && !this.error) {
      this.addChild(new Text(colors.thinkingText("Thinking..."), 2, 0));
    }

    if (this.toolStatus) {
      this.addChild(new Text(colors.dim(this.toolStatus), 2, 0));
    }

    if (this.harnessStatus) {
      this.addChild(new Text(colors.dim(this.harnessStatus), 2, 0));
    }

    if (this.contextUsage) {
      this.addChild(new Text(colors.dim(this.contextUsage), 2, 0));
    }

    for (const toolResult of this.toolResults) {
      this.addChild(createToolResultComponent(toolResult));
    }

    if (this.toolResults.length > 0 && (this.response.trim() || this.error)) {
      this.addChild(new Spacer(1));
    }

    if (this.error) {
      this.addChild(new Text(`${colors.red("citybrain error")}\n\n${this.error}`, 2, 1));
      return;
    }

    if (this.response.trim()) {
      this.addChild(
        new Markdown(
          `${colors.green("citybrain")}\n\n${this.response}`,
          2,
          1,
          createMarkdownTheme(),
        ),
      );
    }
  }
}

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

/** Persistent bottom line showing the active file-system sandbox (citybrain/). */
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
      ` ${truncateToWidth(`${colors.cyan("sandbox")}  ${colors.dim(this.path)}`, innerWidth, "")}`,
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
