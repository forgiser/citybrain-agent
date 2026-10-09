import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { getWebClientId } from "./clientId";
import { MarkdownContent } from "./MarkdownContent";
import { SettingsPage, type SettingsOptions, type WebSettings } from "./SettingsPage";
import {
  MAP_VISUALIZATION,
  VisualizationWorkbench,
  type VisualizationKind,
  type VisualizationTab,
} from "./VisualizationWorkbench";
import type {
  Artifact,
  InteractionRequest,
  Message,
  RuntimeEnvelope,
  SessionDetails,
  SessionSummary,
  TaskSnapshot,
} from "./types";

type SidebarTab = "sessions" | "project";
type PendingSessionAction = { kind: "clear" | "delete"; sessionId: string; sessionTitle: string };

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [current, setCurrent] = useState<SessionDetails>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [mapArtifactIds, setMapArtifactIds] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [interaction, setInteraction] = useState<InteractionRequest>();
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("sessions");
  const [settings, setSettings] = useState<WebSettings>();
  const [settingsOptions, setSettingsOptions] = useState<SettingsOptions>({ thinkingLevels: [], models: [], providers: [] });
  const [settingsOpen, setSettingsOpen] = useState(location.pathname === "/settings");
  const [runId, setRunId] = useState<string>();
  const [runStatus, setRunStatus] = useState("idle");
  const [error, setError] = useState<string>();
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [pendingSessionAction, setPendingSessionAction] = useState<PendingSessionAction>();
  const [visualizations, setVisualizations] = useState<VisualizationTab[]>([{ ...MAP_VISUALIZATION }]);
  const [activeVisualizationId, setActiveVisualizationId] = useState("map");
  const eventSourceRef = useRef<EventSource | undefined>(undefined);
  const visualizationTabsRef = useRef(visualizations);
  const activeVisualizationRef = useRef(activeVisualizationId);
  const webClientIdRef = useRef(getWebClientId());

  const resetVisualizations = useCallback(() => {
    setVisualizations([{ ...MAP_VISUALIZATION }]);
    setActiveVisualizationId("map");
    setMapArtifactIds(new Set());
  }, []);

  const registerArtifact = useCallback((artifact: Artifact) => {
    setArtifacts((value) => [artifact, ...value.filter((item) => item.id !== artifact.id)]);
  }, []);

  const addArtifactToMap = useCallback((artifact: Artifact) => {
    registerArtifact(artifact);
    setMapArtifactIds((value) => new Set(value).add(artifact.id));
  }, [registerArtifact]);

  const removeArtifactFromMap = useCallback((artifactId: string) => {
    setMapArtifactIds((value) => {
      const next = new Set(value);
      next.delete(artifactId);
      return next;
    });
  }, []);

  const refreshArtifacts = useCallback(async (sessionId: string) => {
    setArtifacts(await api<Artifact[]>(`/api/artifacts?sessionId=${encodeURIComponent(sessionId)}`));
  }, []);

  const loadSession = useCallback(async (sessionId: string, activate = false) => {
    if (activate) await api(`/api/sessions/${sessionId}/activate`, { method: "POST" });
    const detail = await api<SessionDetails>(`/api/sessions/${sessionId}`);
    setCurrent(detail);
    setMessages(detail.messages.filter((message) =>
      message.role !== "assistant" || Boolean(message.content || message.thinking),
    ));
    resetVisualizations();
    await refreshArtifacts(sessionId);
  }, [refreshArtifacts, resetVisualizations]);

  const reportVisualizationState = useCallback(async (sessionId: string) => {
    await api(`/api/sessions/${sessionId}/visualization-state`, {
      method: "PUT",
      body: JSON.stringify({
        clientId: webClientIdRef.current,
        activeTabId: activeVisualizationRef.current,
        tabs: visualizationTabsRef.current.map(({ id, kind, title, sourcePath, artifactId, closable }) => ({
          id, kind, title, sourcePath, artifactId, closable,
        })),
      }),
    });
  }, []);

  useEffect(() => {
    visualizationTabsRef.current = visualizations;
    activeVisualizationRef.current = activeVisualizationId;
    if (current?.id) void reportVisualizationState(current.id).catch(() => undefined);
  }, [activeVisualizationId, current?.id, reportVisualizationState, visualizations]);

  useEffect(() => {
    if (!current?.id) return;
    const sessionId = current.id;
    const timer = window.setInterval(() => void reportVisualizationState(sessionId).catch(() => undefined), 15_000);
    return () => {
      window.clearInterval(timer);
      void api(`/api/sessions/${sessionId}/visualization-state`, {
        method: "DELETE",
        body: JSON.stringify({ clientId: webClientIdRef.current }),
      }).catch(() => undefined);
    };
  }, [current?.id, reportVisualizationState]);

  const bootstrap = useCallback(async () => {
    const boot = await api<{
      currentSessionId: string | null;
      settings: WebSettings;
      options: SettingsOptions;
    }>("/api/bootstrap");
    setSettings(boot.settings);
    setSettingsOptions(boot.options);
    const list = await api<SessionSummary[]>("/api/sessions");
    setSessions(list);
    if (boot.currentSessionId) await loadSession(boot.currentSessionId);
    else {
      setCurrent(undefined);
      setMessages([]);
      setArtifacts([]);
      resetVisualizations();
    }
    setTasks(await api<TaskSnapshot[]>("/api/tasks"));
    const pending = await api<InteractionRequest[]>("/api/interactions");
    setInteraction(pending[0]);
  }, [loadSession, resetVisualizations]);

  useEffect(() => {
    let cancelled = false;
    void bootstrap().catch((cause) => {
      if (!cancelled) setError(messageOf(cause));
    });
    return () => {
      cancelled = true;
      eventSourceRef.current?.close();
      eventSourceRef.current = undefined;
    };
  }, [bootstrap]);

  useEffect(() => {
    if (settings?.theme) document.documentElement.dataset.theme = settings.theme;
  }, [settings?.theme]);

  async function selectSession(sessionId: string) {
    if (runStatus === "running" || runStatus === "waiting_for_human") return;
    setError(undefined);
    await loadSession(sessionId, true);
  }

  async function createSession(projectDir: string) {
    setError(undefined);
    try {
      const detail = await api<SessionDetails>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ projectDir }),
      });
      const list = await api<SessionSummary[]>("/api/sessions");
      setSessions(list);
      setCurrent(detail);
      setMessages([]);
      setArtifacts([]);
      resetVisualizations();
      setDirectoryPickerOpen(false);
    } catch (cause) {
      setError(messageOf(cause));
      throw cause;
    }
  }

  function requestSessionAction(kind: PendingSessionAction["kind"], sessionId: string) {
    if (runStatus === "running" || runStatus === "waiting_for_human" || runStatus === "queued") return;
    const session = sessions.find((item) => item.id === sessionId);
    setPendingSessionAction({ kind, sessionId, sessionTitle: session?.title ?? "当前会话" });
  }

  async function confirmSessionAction() {
    const action = pendingSessionAction;
    if (!action) return;
    setPendingSessionAction(undefined);
    if (action.kind === "clear") await clearSession(action.sessionId);
    else await deleteSession(action.sessionId);
  }

  async function clearSession(sessionId: string) {
    setError(undefined);
    try {
      const detail = await api<SessionDetails>(`/api/sessions/${sessionId}/clear`, { method: "POST" });
      if (current?.id === sessionId) {
        setCurrent(detail);
        setMessages([]);
      }
      setSessions(await api<SessionSummary[]>("/api/sessions"));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function deleteSession(sessionId: string) {
    setError(undefined);
    try {
      const result = await api<{ currentSession: SessionDetails | null }>(`/api/sessions/${sessionId}`, { method: "DELETE" });
      if (current?.id === sessionId) {
        setCurrent(result.currentSession ?? undefined);
        setMessages(result.currentSession?.messages ?? []);
        setArtifacts([]);
        resetVisualizations();
        if (result.currentSession) await refreshArtifacts(result.currentSession.id);
      }
      setSessions(await api<SessionSummary[]>("/api/sessions"));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  function openVisualization(tab: VisualizationTab) {
    setVisualizations((value) => {
      const existing = value.findIndex((item) => item.id === tab.id);
      if (existing < 0) return [...value, tab];
      const next = [...value];
      next[existing] = { ...next[existing], ...tab };
      return next;
    });
    setActiveVisualizationId(tab.id);
  }

  function closeVisualization(id: string) {
    if (id === "map") return;
    setVisualizations((value) => value.filter((item) => item.id !== id));
    if (activeVisualizationId === id) setActiveVisualizationId("map");
  }

  async function sendMessage(input: string) {
    if (!current || !input.trim()) return;
    setError(undefined);
    setMessages((value) => [...value, { role: "user", content: input }, { role: "assistant", content: "", thinking: "" }]);
    const run = await api<{ id: string; status: string; eventsUrl: string }>(
      `/api/sessions/${current.id}/runs`,
      { method: "POST", body: JSON.stringify({ input }) },
    );
    setRunId(run.id);
    setRunStatus(run.status);
    eventSourceRef.current?.close();
    const source = new EventSource(run.eventsUrl);
    eventSourceRef.current = source;
    source.onmessage = (event) => handleRuntimeEvent(JSON.parse(event.data) as RuntimeEnvelope);
    source.onerror = () => setError("事件连接暂时中断，浏览器会自动重连。");
  }

  function handleRuntimeEvent(envelope: RuntimeEnvelope) {
    if (envelope.type === "message.text_delta") {
      const delta = String(envelope.data.delta ?? "");
      setMessages((value) => appendAssistant(value, "content", delta));
      return;
    }
    if (envelope.type === "message.thinking_delta") {
      const delta = String(envelope.data.delta ?? "");
      setMessages((value) => appendAssistant(value, "thinking", delta));
      return;
    }
    if (envelope.type === "run.state_changed") {
      const run = envelope.data.run as { status?: string } | undefined;
      if (run?.status) setRunStatus(run.status);
    }
    if (envelope.type === "run.completed" || envelope.type === "run.failed") {
      setRunStatus(envelope.type === "run.completed" ? "completed" : "failed");
      if (current) {
        void refreshArtifacts(current.id);
        void api<TaskSnapshot[]>("/api/tasks").then(setTasks);
        void api<SessionSummary[]>("/api/sessions").then(setSessions);
      }
    }
    if (envelope.type === "agent.event") {
      const agentEvent = envelope.data.event as Record<string, unknown> | undefined;
      if (agentEvent?.type === "tool_started") {
        setMessages((value) => upsertToolMessage(value, agentEvent, envelope.eventId, "running"));
      } else if (agentEvent?.type === "tool_result") {
        const status = agentEvent.status === "background"
          ? "background"
          : agentEvent.ok ? "completed" : "failed";
        setMessages((value) => upsertToolMessage(value, agentEvent, envelope.eventId, status));
        if (current) void refreshArtifacts(current.id);
      }
    }
    if (envelope.type.startsWith("task.")) {
      const task = envelope.data.task as TaskSnapshot | undefined;
      if (task) setTasks((value) => [task, ...value.filter((item) => item.id !== task.id)]);
      if (current) void refreshArtifacts(current.id);
    }
    if (envelope.type === "interaction.created") {
      const event = envelope.data as unknown as { request?: InteractionRequest };
      setInteraction(event.request);
    }
    if (envelope.type.startsWith("interaction.") && envelope.type !== "interaction.created") {
      setInteraction(undefined);
    }
  }

  async function answerInteraction(optionId: string) {
    if (!interaction) return;
    const option = interaction.options.find((item) => item.id === optionId);
    const action = optionId.includes("reject") || optionId.includes("deny") ? "reject" : "select";
    await api(`/api/interactions/${interaction.requestId}/respond`, {
      method: "POST",
      body: JSON.stringify({ action, optionId }),
    });
    setInteraction(undefined);
  }

  async function cancelRun() {
    if (!runId) return;
    await api(`/api/runs/${runId}/cancel`, { method: "POST" });
    setRunStatus("cancelled");
  }

  function openSettings() {
    history.pushState({}, "", "/settings");
    setSettingsOpen(true);
  }

  function closeSettings() {
    history.pushState({}, "", "/");
    setSettingsOpen(false);
  }

  if (settingsOpen && settings) {
    return <SettingsPage settings={settings} options={settingsOptions} onChange={setSettings} onOptionsChange={setSettingsOptions} onBack={closeSettings} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span>◆</span><strong>CITY-BRAIN</strong></div>
        <div className="workspace-title">{current?.projectDir ?? "尚未选择项目目录"}</div>
        <div className={`run-pill ${runStatus}`}><span />{runStatus}</div>
      </header>
      <div className="main-grid">
        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button className={sidebarTab === "sessions" ? "active" : ""} onClick={() => setSidebarTab("sessions")}>会话</button>
            <button className={sidebarTab === "project" ? "active" : ""} onClick={() => setSidebarTab("project")}>项目目录</button>
          </div>
          <div className="sidebar-content">
            {sidebarTab === "sessions" ? (
              <SessionList
                sessions={sessions}
                currentId={current?.id}
                onSelect={selectSession}
                onCreate={() => setDirectoryPickerOpen(true)}
                onClear={(id) => requestSessionAction("clear", id)}
                onDelete={(id) => requestSessionAction("delete", id)}
              />
            ) : current ? (
              <ProjectExplorer
                session={current}
                onArtifact={registerArtifact}
                onAddToMap={addArtifactToMap}
                onOpenVisualization={openVisualization}
                onShowMap={() => setActiveVisualizationId("map")}
              />
            ) : null}
          </div>
          <button className="settings-button" onClick={openSettings}>⚙<span>设置</span></button>
        </aside>

        <VisualizationWorkbench
          sessionId={current?.id}
          artifacts={artifacts.filter((artifact) => mapArtifactIds.has(artifact.id))}
          autoFit={settings?.autoFitNewLayers ?? true}
          baseMap={settings?.baseMap ?? "osm"}
          tabs={visualizations}
          activeTabId={activeVisualizationId}
          onActivate={setActiveVisualizationId}
          onClose={closeVisualization}
          onLayerAdded={addArtifactToMap}
          onLayerRemoved={removeArtifactFromMap}
        />

        <ChatPanel
          messages={messages}
          tasks={tasks}
          interaction={interaction}
          available={Boolean(current)}
          running={runStatus === "running" || runStatus === "waiting_for_human" || runStatus === "queued"}
          onSend={sendMessage}
          onCancel={cancelRun}
          onAnswer={answerInteraction}
        />
      </div>
      {error && <div className="error-toast" onClick={() => setError(undefined)}>{error}</div>}
      {directoryPickerOpen && (
        <DirectoryPickerDialog
          recentPaths={[...new Set(sessions.map((session) => session.projectDir))]}
          onCancel={() => setDirectoryPickerOpen(false)}
          onSelect={createSession}
        />
      )}
      {pendingSessionAction && (
        <ConfirmDialog
          title={pendingSessionAction.kind === "delete" ? "删除会话" : "清空会话"}
          message={pendingSessionAction.kind === "delete"
            ? `确定删除“${pendingSessionAction.sessionTitle}”吗？会话记录将无法恢复。`
            : `确定清空“${pendingSessionAction.sessionTitle}”的全部消息吗？此操作不可撤销。`}
          confirmLabel={pendingSessionAction.kind === "delete" ? "删除" : "清空"}
          dangerous
          onCancel={() => setPendingSessionAction(undefined)}
          onConfirm={confirmSessionAction}
        />
      )}
    </div>
  );
}

function SessionList({ sessions, currentId, onSelect, onCreate, onClear, onDelete }: {
  sessions: SessionSummary[];
  currentId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClear: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return <div className="session-list">
    <button className="new-session" onClick={onCreate}>＋ 新建会话</button>
    {sessions.map((session) => <div key={session.id} className={`session-item ${session.id === currentId ? "active" : ""}`}>
      <button className="session-select" onClick={() => onSelect(session.id)}>
        <strong>{session.title}</strong>
        <span>{session.projectDir}</span>
        <small>{new Date(session.modifiedAt).toLocaleString()}</small>
      </button>
      <div className="session-actions">
        <button title="清空消息" aria-label={`清空 ${session.title}`} onClick={() => void onClear(session.id)}>清空</button>
        <button className="danger" title="删除会话" aria-label={`删除 ${session.title}`} onClick={() => void onDelete(session.id)}>删除</button>
      </div>
    </div>)}
  </div>;
}

function ProjectExplorer({ session, onArtifact, onAddToMap, onOpenVisualization, onShowMap }: {
  session: SessionDetails;
  onArtifact: (artifact: Artifact) => void;
  onAddToMap: (artifact: Artifact) => void;
  onOpenVisualization: (tab: VisualizationTab) => void;
  onShowMap: () => void;
}) {
  type WorkspaceItem = {
    name: string;
    relativePath: string;
    type: string;
    size?: number;
    previewable: boolean;
    mappable: boolean;
    visualization?: VisualizationKind;
  };
  const [roots, setRoots] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const [rootId, setRootId] = useState("workspace");
  const [path, setPath] = useState("");
  const [items, setItems] = useState<WorkspaceItem[]>([]);

  const load = useCallback(async (nextRoot = rootId, nextPath = path) => {
    const result = await api<{ items: typeof items }>(`/api/sessions/${session.id}/files?rootId=${encodeURIComponent(nextRoot)}&path=${encodeURIComponent(nextPath)}`);
    setItems(result.items);
  }, [path, rootId, session.id]);

  useEffect(() => {
    let cancelled = false;
    void api<{ roots: typeof roots }>(`/api/sessions/${session.id}/workspace`).then((result) => {
      if (cancelled) return;
      setRoots(result.roots);
      const first = result.roots[0]?.id ?? "workspace";
      setRootId(first);
      setPath("");
      void api<{ items: typeof items }>(
        `/api/sessions/${session.id}/files?rootId=${encodeURIComponent(first)}&path=`,
      ).then((files) => {
        if (!cancelled) setItems(files.items);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  async function open(item: typeof items[number]) {
    if (item.type === "directory") {
      setPath(item.relativePath);
      await load(rootId, item.relativePath);
    } else if (item.visualization === "map") {
      await addMap(item);
      onShowMap();
    } else if (item.visualization === "image") {
      const artifact = await registerFileArtifact(item);
      onOpenVisualization({
        id: `file:${rootId}:${item.relativePath}`,
        kind: "image",
        title: item.name,
        sourcePath: sourcePath(item.relativePath),
        artifactId: artifact.id,
        contentUrl: artifact.contentUrl,
        closable: true,
      });
    } else if (item.visualization && item.previewable) {
      const result = await api<{ content: string }>(`/api/sessions/${session.id}/files/content?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(item.relativePath)}`);
      onOpenVisualization({
        id: `file:${rootId}:${item.relativePath}`,
        kind: item.visualization,
        title: item.name,
        sourcePath: sourcePath(item.relativePath),
        content: result.content,
        closable: true,
      });
    }
  }

  async function registerFileArtifact(item: typeof items[number]) {
    const artifact = await api<Artifact>(`/api/sessions/${session.id}/artifacts`, {
      method: "POST",
      body: JSON.stringify({ rootId, path: item.relativePath }),
    });
    onArtifact(artifact);
    return artifact;
  }

  async function addMap(item: typeof items[number]) {
    const artifact = await registerFileArtifact(item);
    onAddToMap(artifact);
    return artifact;
  }

  function sourcePath(relativePath: string) {
    const root = roots.find((item) => item.id === rootId)?.path;
    return root ? `${root.replace(/[\\/]$/u, "")}\\${relativePath.replaceAll("/", "\\")}` : relativePath;
  }

  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return <div className="project-explorer">
    <select value={rootId} onChange={(event) => { setRootId(event.target.value); setPath(""); void load(event.target.value, ""); }}>
      {roots.map((root) => <option value={root.id} key={root.id}>{root.name}</option>)}
    </select>
    <div className="path-row"><button disabled={!path} onClick={() => { setPath(parent); void load(rootId, parent); }}>←</button><span>/{path}</span><button onClick={() => void load()}>↻</button></div>
    {items.map((item) => <div className="file-row" key={item.relativePath}>
      <button onClick={() => void open(item)}><span>{item.type === "directory" ? "▸" : fileIcon(item.name)}</span><span>{item.name}</span></button>
      {item.mappable && <button className="map-add" title="添加到地图" onClick={() => void addMap(item).then(onShowMap)}>＋图</button>}
    </div>)}
  </div>;
}

function ChatPanel({ messages, tasks, interaction, available, running, onSend, onCancel, onAnswer }: {
  messages: Message[];
  tasks: TaskSnapshot[];
  interaction?: InteractionRequest;
  available: boolean;
  running: boolean;
  onSend: (input: string) => void;
  onCancel: () => void;
  onAnswer: (id: string) => void | Promise<void>;
}) {
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [interaction, messages, tasks]);
  function submit() {
    if (!available || !input.trim() || running) return;
    const value = input;
    setInput("");
    void onSend(value);
  }
  return <aside className="chat-panel">
    <div className="panel-heading"><div><h2>Agent 问答</h2></div><span className="online-dot">在线</span></div>
    <div className="chat-scroll">
      {messages.length === 0 && <div className="empty-chat"><div>◇</div><h3>{available ? "从空间问题开始" : "尚未进入会话"}</h3><p>{available ? "询问数据、运行 QGIS 分析，结果会直接出现在地图中。" : "请从左侧选择历史会话，或选择项目目录创建新会话。"}</p></div>}
      {messages.map((message, index) => message.role === "tool" ? (
        <ToolMessage message={message} key={message.id ?? `tool-${index}`} />
      ) : (
        <div className={`message ${message.role}`} key={`${index}-${message.id ?? "live"}`}>
          <span className="message-label">{message.role === "user" ? "你" : "CityBrain"}</span>
          {message.thinking && <details><summary>思考过程</summary><pre>{message.thinking}</pre></details>}
          <div className="message-content">
            {message.content
              ? message.role === "assistant" ? <MarkdownContent>{message.content}</MarkdownContent> : message.content
              : message.role === "assistant" ? <span className="typing">● ● ●</span> : ""}
          </div>
        </div>
      ))}
      {tasks.filter((task) => !["completed", "failed", "cancelled", "timed_out"].includes(task.status)).map((task) => <div className="task-card" key={task.id}>
        <div><strong>{task.description ?? task.name}</strong><span>{task.status}</span></div>
        <div className="progress"><i style={{ width: `${task.progress?.percent ?? 20}%` }} /></div>
        <small>{task.progress?.message ?? "后台处理中"}</small>
      </div>)}
      {interaction && <HumanInteractionCard request={interaction} onAnswer={onAnswer} />}
      <div ref={bottom} />
    </div>
    <div className="composer">
      <textarea disabled={!available} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={available ? "描述你的空间分析任务…" : "请先选择或创建会话"} />
      {running ? <button className="stop" onClick={onCancel}>停止</button> : <button disabled={!available} onClick={submit}>发送 ↑</button>}
    </div>
  </aside>;
}

function HumanInteractionCard({ request, onAnswer }: {
  request: InteractionRequest;
  onAnswer: (id: string) => void | Promise<void>;
}) {
  const [submitting, setSubmitting] = useState<string>();
  async function answer(optionId: string) {
    if (submitting) return;
    setSubmitting(optionId);
    try {
      await onAnswer(optionId);
    } finally {
      setSubmitting(undefined);
    }
  }
  return <section className={`hitl-card risk-${request.risk ?? "medium"}`} aria-label="需要用户确认">
    <div className="hitl-heading"><span>HITL</span><strong>{request.title}</strong></div>
    <p>{request.message}</p>
    <div className="hitl-options">
      {request.options.map((option) => <button
        className={option.dangerous ? "danger" : ""}
        disabled={Boolean(submitting)}
        key={option.id}
        onClick={() => void answer(option.id)}
      >
        <strong>{submitting === option.id ? "提交中…" : option.label}</strong>
        {option.description && <small>{option.description}</small>}
      </button>)}
    </div>
  </section>;
}

function ToolMessage({ message }: { message: Message }) {
  const status = message.toolStatus ?? "completed";
  const statusLabel = {
    running: "执行中",
    completed: "已完成",
    failed: "执行失败",
    background: "已转入后台",
  }[status];
  const hasDetails = Boolean(message.toolArguments || message.content);

  return (
    <div className={`tool-message ${status}`}>
      <div className="tool-message-heading">
        <span className="tool-icon" aria-hidden="true">{status === "running" ? "◌" : status === "failed" ? "!" : "✓"}</span>
        <div>
          <strong>{message.toolName ?? "工具调用"}</strong>
          {message.toolSummary && <small>{message.toolSummary}</small>}
        </div>
        <span className="tool-status">{statusLabel}</span>
      </div>
      {hasDetails && (
        <details>
          <summary>查看执行详情</summary>
          {message.toolArguments && <><label>参数</label><pre>{formatToolArguments(message.toolArguments)}</pre></>}
          {message.content && <><label>结果</label><pre>{message.content}</pre></>}
        </details>
      )}
    </div>
  );
}

function ModalFrame({ children, className = "app-dialog", onClose }: {
  children: ReactNode;
  className?: string;
  onClose?: () => void;
}) {
  useEffect(() => {
    if (!onClose) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (onClose && event.target === event.currentTarget) onClose();
  }}><div className={className} role="dialog" aria-modal="true">{children}</div></div>;
}

function ConfirmDialog({ title, message, confirmLabel, dangerous = false, onCancel, onConfirm }: {
  title: string;
  message: string;
  confirmLabel: string;
  dangerous?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  async function confirm() {
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }
  return <ModalFrame onClose={submitting ? undefined : onCancel}>
    <div className="dialog-icon danger">!</div>
    <h2>{title}</h2>
    <p>{message}</p>
    <div className="dialog-actions">
      <button className="secondary" disabled={submitting} onClick={onCancel}>取消</button>
      <button className={dangerous ? "danger" : "primary"} disabled={submitting} onClick={() => void confirm()}>{submitting ? "处理中…" : confirmLabel}</button>
    </div>
  </ModalFrame>;
}

interface DirectoryListing {
  path: string;
  parent?: string;
  roots: string[];
  directories: Array<{ name: string; path: string }>;
}

function DirectoryPickerDialog({ recentPaths, onCancel, onSelect }: {
  recentPaths: string[];
  onCancel: () => void;
  onSelect: (path: string) => Promise<void>;
}) {
  const [listing, setListing] = useState<DirectoryListing>();
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [browseError, setBrowseError] = useState<string>();

  const browse = useCallback(async (path: string) => {
    setLoading(true);
    setBrowseError(undefined);
    try {
      const query = path.trim() ? `?path=${encodeURIComponent(path.trim())}` : "";
      const result = await api<DirectoryListing>(`/api/directories${query}`);
      setListing(result);
      if (result.path) setPathInput(result.path);
    } catch (cause) {
      setBrowseError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void browse("");
  }, [browse]);

  async function selectDirectory() {
    if (!pathInput.trim()) return;
    setSubmitting(true);
    try {
      await onSelect(pathInput.trim());
    } catch {
      setBrowseError("创建会话失败，请检查目录权限或路径后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return <ModalFrame className="directory-dialog" onClose={submitting ? undefined : onCancel}>
    <div className="dialog-heading"><div><small>PROJECT WORKSPACE</small><h2>选择项目目录</h2></div><button aria-label="关闭" onClick={onCancel}>×</button></div>
    <p className="dialog-description">从磁盘或最近项目中选择一个现有目录。应用不会预先指定项目目录。</p>
    <form className="directory-path" onSubmit={(event) => { event.preventDefault(); void browse(pathInput); }}>
      <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} spellCheck={false} aria-label="目录路径" placeholder="输入项目目录的绝对路径" />
      <button disabled={loading || !pathInput.trim()}>{loading ? "读取中" : "转到"}</button>
    </form>
    {listing && <div className="directory-roots">{listing.roots.map((root) => <button key={root} onClick={() => void browse(root)}>{root}</button>)}</div>}
    {recentPaths.length > 0 && !listing?.path && <div className="recent-directories"><small>最近项目</small>{recentPaths.map((path) => <button key={path} onClick={() => setPathInput(path)} onDoubleClick={() => void browse(path)} className={pathInput === path ? "selected" : ""}><strong>{directoryName(path)}</strong><span>{path}</span></button>)}</div>}
    <div className="directory-list" aria-busy={loading}>
      {listing?.parent && <button onClick={() => void browse(listing.parent!)}><span>↰</span><strong>上一级</strong><small>{listing.parent}</small></button>}
      {listing?.directories.map((directory) => <button key={directory.path} onDoubleClick={() => void browse(directory.path)} onClick={() => setPathInput(directory.path)} className={pathInput === directory.path ? "selected" : ""}>
        <span>▸</span><strong>{directory.name}</strong><small>{directory.path}</small>
      </button>)}
      {!loading && listing?.path && listing.directories.length === 0 && <div className="directory-empty">当前目录没有子目录</div>}
      {!loading && !listing?.path && <div className="directory-empty">请选择磁盘、最近项目，或输入绝对路径</div>}
    </div>
    {browseError && <div className="dialog-error">{browseError}</div>}
    <div className="dialog-actions">
      <button className="secondary" disabled={submitting} onClick={onCancel}>取消</button>
      <button className="primary" disabled={loading || submitting || !pathInput.trim()} onClick={() => void selectDirectory()}>{submitting ? "创建中…" : "选择此目录"}</button>
    </div>
  </ModalFrame>;
}

function appendAssistant(messages: Message[], field: "content" | "thinking", delta: string): Message[] {
  const next = [...messages];
  const last = next.at(-1);
  if (last?.role === "assistant") {
    next[next.length - 1] = { ...last, [field]: `${last[field] ?? ""}${delta}` };
  } else {
    next.push({ role: "assistant", content: "", [field]: delta });
  }
  return next;
}

function upsertToolMessage(
  messages: Message[],
  event: Record<string, unknown>,
  fallbackId: string,
  status: NonNullable<Message["toolStatus"]>,
): Message[] {
  const toolCallId = readEventString(event.toolCallId) ?? fallbackId;
  const id = `tool-${toolCallId}`;
  const existingIndex = messages.findIndex((message) => message.role === "tool" && message.id === id);
  const existing = existingIndex >= 0 ? messages[existingIndex] : undefined;
  const nextMessage: Message = {
    ...existing,
    id,
    role: "tool",
    toolCallId,
    toolName: readEventString(event.name) ?? existing?.toolName ?? "tool",
    toolStatus: status,
    toolSummary: readEventString(event.toolUseSummary)
      ?? readEventString(event.activityDescription)
      ?? existing?.toolSummary,
    toolArguments: readEventString(event.argumentsText) ?? existing?.toolArguments,
    content: readEventString(event.result) ?? existing?.content ?? "",
  };

  if (existingIndex < 0) {
    const last = messages.at(-1);
    if (last?.role === "assistant" && !last.content && !last.thinking) {
      return [...messages.slice(0, -1), nextMessage];
    }
    return [...messages, nextMessage];
  }
  const next = [...messages];
  next[existingIndex] = nextMessage;
  return next;
}

function readEventString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function formatToolArguments(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function fileIcon(name: string): string {
  return /\.(geojson|json|shp|gpkg)$/iu.test(name) ? "◇" : /\.(tif|tiff|png|jpg)$/iu.test(name) ? "▧" : "·";
}

function directoryName(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).at(-1) || path;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
