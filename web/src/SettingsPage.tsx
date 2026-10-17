import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "./api";

export interface WebSettings {
  thinkingLevel: "off" | "high" | "max";
  selectedModel?: string;
  autoFitNewLayers: boolean;
  baseMap: "osm" | "blank";
  theme: "dark" | "light";
}

export interface SettingsProvider {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  modelCount: number;
}

export interface SettingsOptions {
  thinkingLevels: string[];
  models: Array<{ reference: string; name: string; provider: string }>;
  qgis?: { version: string; executablePath: string; source?: string };
  providers: SettingsProvider[];
}

type SettingsSection = "models" | "agent" | "qgis" | "map" | "appearance" | "observability" | "workflows" | "eval" | "tools" | "tasks" | "security";

const MENU: Array<{ title: string; items: Array<{ id: SettingsSection; label: string; description: string; planned?: boolean }> }> = [
  { title: "通用设置", items: [
    { id: "models", label: "模型服务", description: "服务商、API 与默认模型" },
    { id: "agent", label: "Agent 行为", description: "推理与回答行为" },
    { id: "appearance", label: "界面外观", description: "主题与显示偏好" },
  ] },
  { title: "空间能力", items: [
    { id: "qgis", label: "QGIS 环境", description: "空间处理运行环境" },
    { id: "map", label: "地图配置", description: "底图与图层行为" },
  ] },
  { title: "运行与评估", items: [
    { id: "workflows", label: "工作流", description: "提取、编辑与复跑分析" },
    { id: "eval", label: "评测", description: "基准用例与 Run 评估" },
    { id: "observability", label: "可观测性", description: "链路、Token 与错误" },
    { id: "tasks", label: "后台任务", description: "历史、恢复与产物" },
  ] },
  { title: "扩展与安全", items: [
    { id: "tools", label: "工具与 MCP", description: "工具启用策略", planned: true },
    { id: "security", label: "权限与安全", description: "沙箱和操作确认", planned: true },
  ] },
];

export function SettingsPage({ settings, options: initialOptions, sessionId, onChange, onOptionsChange, onBack }: {
  settings: WebSettings;
  options: SettingsOptions;
  sessionId?: string;
  onChange: (value: WebSettings) => void;
  onOptionsChange: (value: SettingsOptions) => void;
  onBack: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>("models");
  const [draft, setDraft] = useState(settings);
  const [options, setOptions] = useState(initialOptions);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string }>();

  function applyOptions(next: SettingsOptions) {
    setOptions(next);
    onOptionsChange(next);
  }

  async function save() {
    try {
      const value = await api<WebSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(draft) });
      setDraft(value);
      onChange(value);
      setSaved(true);
      setNotice({ kind: "ok", text: "设置已保存并应用。" });
      window.setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  return <div className="settings-page settings-center">
    <header>
      <button onClick={onBack}>← 返回工作区</button>
      {(["models", "agent", "qgis", "map", "appearance"] as SettingsSection[]).includes(section) && <button className="save" onClick={() => void save()}>{saved ? "已保存" : "保存设置"}</button>}
    </header>
    <div className="settings-layout">
      <nav className="settings-menu" aria-label="设置分类">
        {MENU.map((group) => <div className="settings-menu-group" key={group.title}><h3>{group.title}</h3>{group.items.map((item) => <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => setSection(item.id)}>
          <span><strong>{item.label}</strong>{item.planned && <em>待集成</em>}</span>
          <small>{item.description}</small>
        </button>)}</div>)}
      </nav>
      <main className="settings-content">
        {notice && <div className={`settings-notice ${notice.kind}`} onClick={() => setNotice(undefined)}>{notice.text}</div>}
        {section === "models" && <ModelSettingsPanel
          draft={draft}
          options={options}
          onDraft={setDraft}
          onOptions={applyOptions}
          onSettings={(value) => { setDraft(value); onChange(value); }}
          onNotice={setNotice}
        />}
        {section === "agent" && <SettingsModule eyebrow="AGENT BEHAVIOR" title="Agent 行为" description="控制模型推理强度。该设置会立即参与之后的 Agent 请求。">
          <SettingField title="Thinking level" description="更高等级可能获得更充分的推理，但会增加响应耗时和 Token 消耗。">
            <select value={draft.thinkingLevel} onChange={(event) => setDraft({ ...draft, thinkingLevel: event.target.value as WebSettings["thinkingLevel"] })}>
              {options.thinkingLevels.map((level) => <option value={level} key={level}>{level}</option>)}
            </select>
          </SettingField>
        </SettingsModule>}
        {section === "qgis" && <QgisSettingsPanel options={options} onOptions={applyOptions} onNotice={setNotice} />}
        {section === "map" && <SettingsModule eyebrow="MAP WORKSPACE" title="地图" description="配置 Web 地图的底图和显式加载图层后的行为。">
          <SettingField title="默认底图" description="空白底图适合离线环境，OpenStreetMap 需要网络连接。">
            <select value={draft.baseMap} onChange={(event) => setDraft({ ...draft, baseMap: event.target.value as WebSettings["baseMap"] })}><option value="osm">OpenStreetMap</option><option value="blank">空白底图</option></select>
          </SettingField>
          <SettingField title="添加图层后自动缩放" description="仅影响手动或通过 map_add_layer 明确添加的图层，不会自动加载生成文件。">
            <label className="setting-switch"><input type="checkbox" checked={draft.autoFitNewLayers} onChange={(event) => setDraft({ ...draft, autoFitNewLayers: event.target.checked })} /><span /></label>
          </SettingField>
        </SettingsModule>}
        {section === "appearance" && <SettingsModule eyebrow="APPEARANCE" title="界面" description="设置 Web UI 的显示风格。">
          <SettingField title="主题" description="主题保存后会立即应用到当前页面。">
            <select value={draft.theme} onChange={(event) => setDraft({ ...draft, theme: event.target.value as WebSettings["theme"] })}><option value="dark">深色</option><option value="light">浅色</option></select>
          </SettingField>
        </SettingsModule>}
        {section === "observability" && <ObservabilityPanel sessionId={sessionId} />}
        {section === "workflows" && <WorkflowPanel sessionId={sessionId} />}
        {section === "eval" && <EvalPanel sessionId={sessionId} />}
        {section === "tasks" && <TaskHistoryPanel sessionId={sessionId} />}
        {(["tools", "security"] as SettingsSection[]).includes(section) && <PlannedSettings section={section} />}
      </main>
    </div>
  </div>;
}

interface ObservationReport {
  generatedAt: string;
  workspaceDir: string;
  summary: {
    runs: number; modelRequests: number; toolCalls: number; toolSuccessRate: number;
    errors: number; hitlRequests: number; artifacts: number; activeTasks: number;
    totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
    contextCompactions: number; peakContextPercent: number;
    averageModelLatencyMs: number; averageToolDurationMs: number; p95ToolDurationMs: number;
  };
  runs: Array<{ runId: string; startedAt?: string; status: string; turns: number; modelRequests: number; toolCalls: number; errors: number; totalTokens: number; durationMs?: number }>;
  tools: Array<{ name: string; calls: number; succeeded: number; failed: number; averageDurationMs: number; p95DurationMs: number; lastExecutedAt?: string }>;
  activeTasks: Array<{ id: string; name: string; status: string; runId?: string; detached: boolean; progress?: number; elapsedMs?: number }>;
  timeline: Array<{ id: string; timestamp: string; kind: string; title: string; status?: string; runId?: string; taskId?: string; tool?: string; durationMs?: number; detail?: string }>;
  logFiles: Array<{ name: string; path: string; size: number; loadedBytes: number; truncated: boolean; exists: boolean }>;
}

function ObservabilityPanel({ sessionId }: { sessionId?: string }) {
  const [report, setReport] = useState<ObservationReport>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [live, setLive] = useState(true);
  const [kind, setKind] = useState("all");
  const [runId, setRunId] = useState("");

  async function refresh() {
    if (!sessionId) {
      setReport(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: "300" });
      if (runId) query.set("runId", runId);
      setReport(await api<ObservationReport>(`/api/sessions/${encodeURIComponent(sessionId)}/observability?${query}`));
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [runId, sessionId]);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [live, runId, sessionId]);

  const timeline = report?.timeline.filter((item) => kind === "all" || item.kind === kind) ?? [];
  const metric = (label: string, value: string | number, hint: string) => <div className="observe-metric"><small>{label}</small><strong>{value}</strong><span>{hint}</span></div>;

  return <SettingsModule eyebrow="AGENT OBSERVABILITY" title="全链路观测" description="从模型请求、上下文、工具、后台任务、HITL、产物和错误多个维度观察当前工作区中的 Agent 运行。完整 Trace 保存在工作区内部日志中，页面只展示聚合指标和安全预览。">
    {!sessionId && <div className="observe-empty">请先创建或选择一个会话，再查看其工作区的 Agent 观测数据。</div>}
    {sessionId && <>
    <div className="observe-toolbar">
      <button onClick={() => void refresh()} disabled={loading}>{loading ? "刷新中…" : "立即刷新"}</button>
      <label><input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} /> 每 5 秒刷新</label>
      <select value={runId} onChange={(event) => setRunId(event.target.value)}><option value="">全部 Run</option>{report?.runs.map((run) => <option key={run.runId} value={run.runId}>{run.runId.slice(0, 18)} · {run.status}</option>)}</select>
    </div>
    {error && <div className="observe-error">{error}</div>}
    {report && <>
      <div className="observe-meta"><span>工作区：{report.workspaceDir}</span><span>生成时间：{formatDate(report.generatedAt)}</span></div>
      <div className="observe-metrics">
        {metric("RUNS", report.summary.runs, `${report.summary.modelRequests} 次模型请求`)}
        {metric("TOOLS", report.summary.toolCalls, `${report.summary.toolSuccessRate.toFixed(1)}% 成功率`)}
        {metric("TOKENS", compactNumber(report.summary.totalTokens), `输入 ${compactNumber(report.summary.inputTokens)} / 输出 ${compactNumber(report.summary.outputTokens)} / 缓存 ${compactNumber(report.summary.cacheReadTokens)}`)}
        {metric("MODEL LATENCY", formatDuration(report.summary.averageModelLatencyMs), "平均响应耗时")}
        {metric("TOOL P95", formatDuration(report.summary.p95ToolDurationMs), `平均 ${formatDuration(report.summary.averageToolDurationMs)}`)}
        {metric("ERRORS", report.summary.errors, `${report.summary.hitlRequests} 次 HITL`)}
        {metric("CONTEXT", `${report.summary.peakContextPercent.toFixed(1)}%`, `${report.summary.contextCompactions} 次压缩`)}
        {metric("ARTIFACTS", report.summary.artifacts, "已登记产物")}
        {metric("ACTIVE TASKS", report.summary.activeTasks, "当前运行或排队")}
      </div>
      {report.activeTasks.length > 0 && <ObserveSection title="活动后台任务">
        <div className="observe-task-list">{report.activeTasks.map((task) => <div key={task.id}><span className="observe-status running">{task.status}</span><strong>{task.name}</strong><small>{task.detached ? "后台执行" : "前台托管"}{task.progress !== undefined ? ` · ${task.progress}%` : ""}</small></div>)}</div>
      </ObserveSection>}
      <div className="observe-columns">
        <ObserveSection title="最近运行">
          {report.runs.length > 0 ? <div className="observe-table"><div className="head"><span>Run</span><span>状态</span><span>模型/工具</span><span>耗时</span></div>{report.runs.slice(0, 12).map((run) => <div key={run.runId}><code title={run.runId}>{run.runId.slice(0, 12)}</code><span className={`observe-status ${run.status}`}>{run.status}</span><span>{run.modelRequests} / {run.toolCalls}</span><span>{formatDuration(run.durationMs ?? 0)}</span></div>)}</div> : <div className="observe-empty">当前工作区还没有运行记录</div>}
        </ObserveSection>
        <ObserveSection title="工具统计">
          {report.tools.length > 0 ? <div className="observe-table tools"><div className="head"><span>工具</span><span>调用</span><span>成功</span><span>P95</span></div>{report.tools.slice(0, 12).map((tool) => <div key={tool.name}><code title={tool.name}>{tool.name}</code><span>{tool.calls}</span><span>{tool.succeeded}/{tool.calls}</span><span>{formatDuration(tool.p95DurationMs)}</span></div>)}</div> : <div className="observe-empty">当前工作区还没有工具调用</div>}
        </ObserveSection>
      </div>
      <ObserveSection title="链路时间线" actions={<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">全部事件</option>{["run", "model", "tool", "task", "hitl", "artifact", "error", "context"].map((value) => <option key={value} value={value}>{value}</option>)}</select>}>
        {timeline.length > 0 ? <div className="observe-timeline">{timeline.slice(0, 100).map((item) => <article key={item.id}><i className={item.kind} /><time>{formatDate(item.timestamp)}</time><div><strong>{item.title}</strong><small>{[item.kind, item.status, item.durationMs !== undefined ? formatDuration(item.durationMs) : undefined].filter(Boolean).join(" · ")}</small>{item.detail && <p>{item.detail}</p>}</div></article>)}</div> : <div className="observe-empty">当前筛选条件下没有事件</div>}
      </ObserveSection>
      <ObserveSection title="日志来源"><div className="observe-log-files">{report.logFiles.map((file) => <div key={file.name}><strong>{file.name}</strong><code>{file.path}</code><span>{file.truncated ? `已读取 ${formatBytes(file.loadedBytes)} / ${formatBytes(file.size)}` : formatBytes(file.size)}</span></div>)}</div></ObserveSection>
    </>}
    </>}
  </SettingsModule>;
}

function ObserveSection({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="observe-section"><header><h3>{title}</h3>{actions}</header>{children}</section>;
}

function formatDuration(value: number): string { return value < 1_000 ? `${Math.round(value)}ms` : value < 60_000 ? `${(value / 1_000).toFixed(1)}s` : `${(value / 60_000).toFixed(1)}min`; }
function compactNumber(value: number): string { return Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false }); }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`; }

function ModelSettingsPanel({ draft, options, onDraft, onOptions, onSettings, onNotice }: {
  draft: WebSettings;
  options: SettingsOptions;
  onDraft: (value: WebSettings) => void;
  onOptions: (value: SettingsOptions) => void;
  onSettings: (value: WebSettings) => void;
  onNotice: (notice: { kind: "ok" | "error"; text: string }) => void;
}) {
  const [providerId, setProviderId] = useState(options.providers[0]?.id ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string>();
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const provider = options.providers.find((item) => item.id === providerId);
  const providerModels = useMemo(() => options.models.filter((model) => model.provider === providerId), [options.models, providerId]);

  async function configure() {
    if (!provider || !apiKey.trim()) return;
    setBusy("configure");
    try {
      const result = await api<{ settings: WebSettings; options: SettingsOptions }>(`/api/settings/providers/${encodeURIComponent(provider.id)}`, { method: "POST", body: JSON.stringify({ apiKey }) });
      setApiKey("");
      onOptions(result.options);
      onSettings(result.settings);
      onDraft(result.settings);
      onNotice({ kind: "ok", text: `${provider.name} 已连接，模型列表已刷新。` });
    } catch (error) {
      onNotice({ kind: "error", text: errorMessage(error) });
    } finally { setBusy(undefined); }
  }

  async function refresh() {
    if (!provider) return;
    setBusy("refresh");
    try {
      const result = await api<{ settings: WebSettings; options: SettingsOptions }>(`/api/settings/providers/${encodeURIComponent(provider.id)}/refresh`, { method: "POST", body: "{}" });
      onOptions(result.options); onSettings(result.settings); onDraft(result.settings);
      onNotice({ kind: "ok", text: `${provider.name} 模型列表已刷新。` });
    } catch (error) { onNotice({ kind: "error", text: errorMessage(error) }); }
    finally { setBusy(undefined); }
  }

  async function disconnect() {
    if (!provider) return;
    if (!disconnectArmed) { setDisconnectArmed(true); return; }
    setBusy("disconnect");
    try {
      const result = await api<{ settings: WebSettings; options: SettingsOptions }>(`/api/settings/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      onOptions(result.options); onSettings(result.settings); onDraft(result.settings);
      setDisconnectArmed(false);
      onNotice({ kind: "ok", text: `${provider.name} 凭据已移除。` });
    } catch (error) { onNotice({ kind: "error", text: errorMessage(error) }); }
    finally { setBusy(undefined); }
  }

  return <SettingsModule eyebrow="MODEL SERVICES" title="模型服务" description="管理模型服务商、本地保存的 API Key 和 Agent 默认使用的模型。API Key 不会返回到浏览器。">
    <div className="provider-tabs">{options.providers.map((item) => <button className={providerId === item.id ? "active" : ""} key={item.id} onClick={() => { setProviderId(item.id); setDisconnectArmed(false); }}><span>{item.name}</span><small>{item.configured ? `已连接 · ${item.modelCount} 模型` : "未连接"}</small></button>)}</div>
    {provider && <div className="provider-config">
      <div className="module-subheading"><div><h3>{provider.name}</h3><p>{provider.description}</p></div><span className={provider.configured ? "connected" : "disconnected"}>{provider.configured ? "已连接" : "未连接"}</span></div>
      <SettingField title="API Key" description={provider.configured ? "已经保存凭据。输入新 Key 可以覆盖原有凭据。" : "凭据会存储在本机用户配置目录中，不会写入项目。"}>
        <div className="inline-control"><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={provider.configured ? "输入新 Key 以更新" : "输入 API Key"} /><button disabled={!apiKey.trim() || Boolean(busy)} onClick={() => void configure()}>{busy === "configure" ? "连接中…" : provider.configured ? "更新凭据" : "连接并探测"}</button></div>
      </SettingField>
      {provider.configured && <div className="provider-actions"><button disabled={Boolean(busy)} onClick={() => void refresh()}>{busy === "refresh" ? "刷新中…" : "刷新模型"}</button><button className="danger" disabled={Boolean(busy)} onClick={() => void disconnect()}>{disconnectArmed ? "再次点击确认移除" : "移除凭据"}</button></div>}
      <SettingField title="默认模型" description={providerModels.length ? "保存后用于新的 Agent 请求。" : "连接服务商并成功探测后才会出现可选模型。"}>
        <select value={draft.selectedModel ?? ""} disabled={options.models.length === 0} onChange={(event) => onDraft({ ...draft, selectedModel: event.target.value })}><option value="" disabled>选择可用模型</option>{options.models.map((model) => <option value={model.reference} key={model.reference}>{model.provider} / {model.name}</option>)}</select>
      </SettingField>
    </div>}
  </SettingsModule>;
}

function QgisSettingsPanel({ options, onOptions, onNotice }: {
  options: SettingsOptions;
  onOptions: (value: SettingsOptions) => void;
  onNotice: (notice: { kind: "ok" | "error"; text: string }) => void;
}) {
  const [path, setPath] = useState(options.qgis?.executablePath ?? "");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => { void api<{ candidates: string[] }>("/api/settings/qgis/candidates").then((value) => setCandidates(value.candidates)).catch(() => undefined); }, []);

  async function configure(selectedPath = path) {
    if (!selectedPath.trim()) return;
    setBusy(true);
    try {
      const result = await api<{ options: SettingsOptions }>("/api/settings/qgis", { method: "PUT", body: JSON.stringify({ path: selectedPath }) });
      onOptions(result.options);
      setPath(selectedPath);
      setPickerOpen(false);
      onNotice({ kind: "ok", text: "QGIS 运行环境验证成功并已应用。" });
    } catch (error) { onNotice({ kind: "error", text: errorMessage(error) }); }
    finally { setBusy(false); }
  }

  async function clear() {
    if (!clearArmed) { setClearArmed(true); return; }
    setBusy(true);
    try {
      const result = await api<{ options: SettingsOptions }>("/api/settings/qgis", { method: "DELETE" });
      onOptions(result.options); setPath(""); setClearArmed(false);
      onNotice({ kind: "ok", text: "QGIS 配置已清除。" });
    } catch (error) { onNotice({ kind: "error", text: errorMessage(error) }); }
    finally { setBusy(false); }
  }

  return <SettingsModule eyebrow="SPATIAL RUNTIME" title="QGIS" description="配置空间处理工具使用的 QGIS 运行方式。当前版本已接入本地 qgis_process，容器和远程运行模式预留在后续版本。">
    <div className="runtime-modes"><button className="active"><strong>本地命令</strong><small>当前可用</small></button><button disabled><strong>Docker</strong><small>待集成</small></button><button disabled><strong>远程服务</strong><small>待集成</small></button></div>
    <div className="runtime-status"><span className={options.qgis ? "connected" : "disconnected"}>{options.qgis ? "运行正常" : "未配置"}</span><div><strong>{options.qgis?.version ?? "尚未连接 QGIS"}</strong><small>{options.qgis?.executablePath ?? "请选择 qgis_process.exe 或对应的 .bat 启动文件"}</small></div></div>
    <SettingField title="qgis_process 命令" description="保存前会实际运行 --version 验证，因此无效路径不会被应用。">
      <div className="inline-control qgis-path-control"><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="C:\\Program Files\\QGIS...\\bin\\qgis_process-qgis-ltr.bat" /><button disabled={busy} onClick={() => setPickerOpen(true)}>浏览文件</button><button disabled={!path.trim() || busy} onClick={() => void configure()}>{busy ? "验证中…" : "验证并应用"}</button></div>
    </SettingField>
    {candidates.length > 0 && <div className="detected-paths"><small>检测到的安装</small>{candidates.map((candidate) => <button key={candidate} onClick={() => setPath(candidate)}>{candidate}</button>)}</div>}
    {options.qgis && <div className="provider-actions"><button className="danger" disabled={busy} onClick={() => void clear()}>{clearArmed ? "再次点击确认清除" : "清除 QGIS 配置"}</button></div>}
    {pickerOpen && <QgisFilePicker initialPath={path || candidates[0] || ""} busy={busy} onCancel={() => setPickerOpen(false)} onApply={(selectedPath) => configure(selectedPath)} />}
  </SettingsModule>;
}

interface QgisFileListing {
  path: string;
  parent?: string;
  roots: string[];
  directories: Array<{ name: string; path: string }>;
  files: Array<{ name: string; path: string }>;
}

function QgisFilePicker({ initialPath, busy, onCancel, onApply }: {
  initialPath: string;
  busy: boolean;
  onCancel: () => void;
  onApply: (path: string) => Promise<void>;
}) {
  const [listing, setListing] = useState<QgisFileListing>();
  const [pathInput, setPathInput] = useState(initialPath);
  const [selectedFile, setSelectedFile] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const browse = async (path: string) => {
    setLoading(true); setError(undefined); setSelectedFile("");
    try {
      const query = path.trim() ? `?path=${encodeURIComponent(path.trim())}` : "";
      const result = await api<QgisFileListing>(`/api/settings/qgis/files${query}`);
      setListing(result);
      if (result.path) setPathInput(result.path);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  };

  useEffect(() => { void browse(initialPath); }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onCancel]);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <div className="qgis-file-dialog" role="dialog" aria-modal="true" aria-label="选择 QGIS 启动文件">
      <div className="dialog-heading"><div><small>QGIS RUNTIME</small><h2>选择 qgis_process 启动文件</h2></div><button onClick={onCancel}>×</button></div>
      <p className="dialog-description">浏览本机文件系统。列表只显示可用的 qgis_process `.bat`、`.cmd` 或 `.exe` 文件。</p>
      <form className="directory-path" onSubmit={(event) => { event.preventDefault(); void browse(pathInput); }}><input value={pathInput} onChange={(event) => setPathInput(event.target.value)} placeholder="输入目录或 qgis_process 文件路径" /><button disabled={loading || !pathInput.trim()}>{loading ? "读取中" : "转到"}</button></form>
      <div className="directory-roots">{listing?.roots.map((root) => <button key={root} onClick={() => void browse(root)}>{root}</button>)}</div>
      <div className="qgis-file-list" aria-busy={loading}>
        {listing?.parent && <button className="folder" onDoubleClick={() => void browse(listing.parent!)} onClick={() => setPathInput(listing.parent!)}><span>↰</span><strong>上一级</strong><small>{listing.parent}</small></button>}
        {listing?.directories.map((directory) => <button className="folder" key={directory.path} onClick={() => setPathInput(directory.path)} onDoubleClick={() => void browse(directory.path)}><span>▸</span><strong>{directory.name}</strong><small>{directory.path}</small></button>)}
        {listing?.files.map((file) => <button className={selectedFile === file.path ? "file selected" : "file"} key={file.path} onClick={() => { setSelectedFile(file.path); setPathInput(file.path); }} onDoubleClick={() => { setSelectedFile(file.path); void onApply(file.path); }}><span>{file.name.split(".").at(-1)?.toUpperCase()}</span><strong>{file.name}</strong><small>{file.path}</small></button>)}
        {!loading && listing?.path && listing.directories.length === 0 && listing.files.length === 0 && <div className="directory-empty">此目录中没有可用的 QGIS 启动文件或子目录</div>}
        {!loading && !listing?.path && <div className="directory-empty">请选择磁盘并进入 QGIS 安装目录</div>}
      </div>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={onCancel}>取消</button><button className="primary" disabled={!selectedFile || busy} onClick={() => void onApply(selectedFile)}>{busy ? "验证应用中…" : "选择并应用"}</button></div>
    </div>
  </div>;
}

interface WorkflowView {
  id: string; name: string; sourceRunId?: string; createdAt: string;
  nodes: Array<{ id: string; tool: string; arguments: Record<string, unknown>; dependencies: string[]; inputPaths: string[]; outputPaths: string[] }>;
}

interface HistoricalTaskView {
  id: string; name: string; status: string; attempt?: number; updatedAt: string;
  progress?: { phase: string; message?: string; percent?: number };
  error?: { code?: string; message: string };
  artifactPaths: string[];
  metadata?: Record<string, unknown>;
}

interface EvalCaseView { id: string; name: string; prompt: string; tags?: string[]; expected: Record<string, unknown> }
interface EvalReportView {
  model: string;
  summary: { total: number; passed: number; successRate: number; averageToolCalls: number; averageTokens: number; p95DurationMs: number };
  cases: Array<{ caseId: string; runId: string; passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }>; metrics: { toolCalls: number; totalTokens: number; durationMs: number } }>;
}

function EvalPanel({ sessionId }: { sessionId?: string }) {
  const [cases, setCases] = useState<EvalCaseView[]>([]);
  const [runOptions, setRunOptions] = useState<Array<{ runId: string; status: string }>>([]);
  const [caseId, setCaseId] = useState("");
  const [runId, setRunId] = useState("");
  const [result, setResult] = useState<{ report: EvalReportView; markdown: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setResult(undefined); setError("");
    if (!sessionId) { setRunOptions([]); return; }
    void Promise.all([
      api<EvalCaseView[]>("/api/evals/cases"),
      api<ObservationReport>(`/api/sessions/${encodeURIComponent(sessionId)}/observability?limit=100`),
    ]).then(([nextCases, observation]) => {
      setCases(nextCases);
      setCaseId((current) => current || nextCases[0]?.id || "");
      setRunOptions(observation.runs);
      setRunId((current) => current || observation.runs[0]?.runId || "");
    }).catch((cause) => setError(errorMessage(cause)));
  }, [sessionId]);

  async function evaluate() {
    if (!sessionId || !caseId || !runId.trim()) return;
    setBusy(true);
    try {
      setResult(await api<{ report: EvalReportView; markdown: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/evals`, {
        method: "POST", body: JSON.stringify({ caseId, runId: runId.trim() }),
      }));
      setError("");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  function download(content: string, extension: "json" | "md") {
    const url = URL.createObjectURL(new Blob([content], { type: extension === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `citybrain-eval-${caseId}-${runId.slice(0, 8)}.${extension}`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const selected = cases.find((item) => item.id === caseId);
  const evaluated = result?.report.cases[0];
  return <SettingsModule eyebrow="AGENT EVALUATION" title="评测" description="用内置 GIS 基准用例检查当前工作区中已完成的 Agent Run。结果来自真实工具日志和产物，不会重新调用模型。完整基准批量执行可使用 CLI。">
    {!sessionId ? <div className="observe-empty">请先创建或选择会话，再评测该工作区的 Run。</div> : <>
      <div className="eval-controls"><label>基准用例<select value={caseId} onChange={(event) => { setCaseId(event.target.value); setResult(undefined); }}>{cases.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.name}</option>)}</select></label><label>Agent Run ID<input list="eval-run-options" value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="选择或输入 Run ID" /><datalist id="eval-run-options">{runOptions.map((item) => <option key={item.runId} value={item.runId}>{item.status}</option>)}</datalist></label><button disabled={busy || !caseId || !runId.trim()} onClick={() => void evaluate()}>{busy ? "评测中…" : "评测 Run"}</button></div>
      {selected && <div className="eval-case-description"><strong>{selected.name}</strong><p>{selected.prompt}</p><small>{selected.tags?.join(" · ")}</small></div>}
      {error && <div className="observe-error">{error}</div>}
      {evaluated && result && <><div className={`eval-result ${evaluated.passed ? "passed" : "failed"}`}><div><strong>{evaluated.passed ? "通过" : "未通过"}</strong><span>{evaluated.caseId} · {result.report.model}</span></div><div><span>工具 {evaluated.metrics.toolCalls}</span><span>Token {evaluated.metrics.totalTokens}</span><span>耗时 {formatDuration(evaluated.metrics.durationMs)}</span></div></div><div className="eval-checks">{evaluated.checks.map((check) => <div key={check.name}><span className={`observe-status ${check.passed ? "completed" : "failed"}`}>{check.passed ? "通过" : "失败"}</span><strong>{check.name}</strong><small>{check.detail}</small></div>)}</div><div className="eval-downloads"><button onClick={() => download(JSON.stringify(result.report, null, 2), "json")}>下载 JSON</button><button onClick={() => download(result.markdown, "md")}>下载 Markdown</button></div></>}
    </>}
  </SettingsModule>;
}

function TaskHistoryPanel({ sessionId }: { sessionId?: string }) {
  const [tasks, setTasks] = useState<HistoricalTaskView[]>([]);
  const [error, setError] = useState("");
  async function refresh() {
    if (!sessionId) { setTasks([]); return; }
    try { setTasks(await api<HistoricalTaskView[]>("/api/tasks")); setError(""); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5_000); return () => window.clearInterval(timer); }, [sessionId]);
  return <SettingsModule eyebrow="DURABLE TASKS" title="后台任务" description="显示当前工作区的持久化任务。进程异常后，不能安全重放的任务标为 orphaned；可恢复的工作流会从已完成节点继续。">
    {!sessionId ? <div className="observe-empty">请先创建或选择会话。</div> : <><div className="observe-toolbar"><button onClick={() => void refresh()}>刷新</button></div>{error && <div className="observe-error">{error}</div>}{tasks.length === 0 && <div className="observe-empty">暂无任务记录。</div>}<div className="task-history-list">{tasks.map((task) => <article key={task.id}><div><strong>{task.name}</strong><span className={`observe-status ${task.status}`}>{task.status}</span></div><small>ID {task.id} · 尝试 {task.attempt ?? 1} · {formatDate(task.updatedAt)}</small>{task.progress && <small>{task.progress.phase} · {task.progress.message ?? ""}{task.progress.percent !== undefined ? ` · ${task.progress.percent}%` : ""}</small>}{task.error && <p className="observe-error">{task.error.code ? `${task.error.code}: ` : ""}{task.error.message}</p>}{typeof task.metadata?.recoveryReason === "string" && <small>恢复原因：{task.metadata.recoveryReason}</small>}{task.artifactPaths.length > 0 && <small>产物：{task.artifactPaths.join("、")}</small>}</article>)}</div></>}
  </SettingsModule>;
}
interface WorkflowExecutionView { status: string; updatedAt: string; nodes: Record<string, { status: string; attempt: number; error?: string }> }

function WorkflowPanel({ sessionId }: { sessionId?: string }) {
  const [items, setItems] = useState<WorkflowView[]>([]);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<{ definition: WorkflowView; execution?: WorkflowExecutionView }>();
  const [runId, setRunId] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState("");
  const [args, setArgs] = useState("");
  const [taskId, setTaskId] = useState("");
  const [taskStatus, setTaskStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/workflows` : "";

  async function refresh() {
    if (!base) { setItems([]); setDetail(undefined); return; }
    try {
      const next = await api<WorkflowView[]>(base);
      setItems(next);
      if (selected) setDetail(await api<{ definition: WorkflowView; execution?: WorkflowExecutionView }>(`${base}/${encodeURIComponent(selected)}`));
      if (taskId) {
        const task = await api<{ status: string }>(`/api/tasks/${encodeURIComponent(taskId)}`);
        setTaskStatus(task.status);
      }
      setError("");
    } catch (cause) { setError(errorMessage(cause)); }
  }

  useEffect(() => { setSelected(""); setDetail(undefined); setTaskId(""); void refresh(); }, [sessionId]);
  useEffect(() => { void refresh(); }, [selected]);
  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [sessionId, selected, taskId]);

  async function create() {
    if (!runId.trim()) return;
    setBusy(true);
    try {
      const created = await api<WorkflowView>(base, { method: "POST", body: JSON.stringify({ runId: runId.trim(), name: name.trim() || undefined }) });
      setSelected(created.id); setRunId(""); setName(""); await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function saveNode(nodeId: string) {
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(args);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("参数必须是 JSON 对象");
      await api(`${base}/${encodeURIComponent(selected)}/nodes/${encodeURIComponent(nodeId)}`, { method: "PATCH", body: JSON.stringify(parsed) });
      setEditing(""); await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function start() {
    setBusy(true);
    try {
      const task = await api<{ id: string; status: string }>(`${base}/${encodeURIComponent(selected)}/runs`, { method: "POST" });
      setTaskId(task.id); setTaskStatus(task.status); await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <SettingsModule eyebrow="REPRODUCIBLE WORKFLOW" title="空间分析工作流" description="从已完成的 Agent Run 提取可重放的 QGIS 处理链；确认节点参数后，可在后台按依赖顺序执行并复用未变化的结果。">
    {!sessionId && <div className="observe-empty">请先创建或选择会话。</div>}
    {sessionId && <>
      <div className="workflow-create"><input aria-label="Agent Run ID" placeholder="Agent Run ID" value={runId} onChange={(event) => setRunId(event.target.value)} /><input aria-label="工作流名称" placeholder="工作流名称（可选）" value={name} onChange={(event) => setName(event.target.value)} /><button disabled={busy || !runId.trim()} onClick={() => void create()}>从 Run 提取</button></div>
      {error && <div className="observe-error">{error}</div>}
      <div className="workflow-layout"><div className="workflow-list">{items.length === 0 && <p>暂无工作流。可从可观测性页面复制 Run ID。</p>}{items.map((item) => <button className={selected === item.id ? "active" : ""} key={item.id} onClick={() => setSelected(item.id)}><strong>{item.name}</strong><small>{item.nodes.length} 个节点 · {item.sourceRunId?.slice(0, 12) ?? "手工创建"}</small></button>)}</div>
      <div className="workflow-detail">{detail ? <><div className="workflow-heading"><div><h3>{detail.definition.name}</h3><small>{detail.execution ? `最近执行：${detail.execution.status} · ${formatDate(detail.execution.updatedAt)}` : "尚未执行"}{taskStatus ? ` · 后台任务：${taskStatus}` : ""}</small></div><button disabled={busy} onClick={() => void start()}>运行工作流</button></div>
        {detail.definition.nodes.map((node) => <article className="workflow-node" key={node.id}><div><strong>{node.id} · {node.tool}</strong><span className={`observe-status ${detail.execution?.nodes[node.id]?.status ?? "queued"}`}>{detail.execution?.nodes[node.id]?.status ?? "未执行"}</span></div><small>依赖：{node.dependencies.join(", ") || "无"}</small><small>输入：{node.inputPaths.join(", ") || "无"}</small><small>输出：{node.outputPaths.join(", ") || "无"}</small>{detail.execution?.nodes[node.id]?.error && <p className="observe-error">{detail.execution.nodes[node.id].error}</p>}
          {editing === node.id ? <><textarea aria-label={`${node.id} 参数`} value={args} onChange={(event) => setArgs(event.target.value)} /><div className="workflow-actions"><button disabled={busy} onClick={() => void saveNode(node.id)}>保存参数</button><button onClick={() => setEditing("")}>取消</button></div></> : <><pre>{JSON.stringify(node.arguments, null, 2)}</pre><button onClick={() => { setEditing(node.id); setArgs(JSON.stringify(node.arguments, null, 2)); }}>编辑参数</button></>}</article>)}
      </> : <div className="observe-empty">选择工作流查看节点、依赖与执行状态。</div>}</div></div>
    </>}
  </SettingsModule>;
}

function SettingsModule({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) {
  return <section className="settings-module"><header><small>{eyebrow}</small><h2>{title}</h2><p>{description}</p></header><div className="settings-module-body">{children}</div></section>;
}

function SettingField({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="setting-field"><div><strong>{title}</strong><small>{description}</small></div><div>{children}</div></div>;
}

function PlannedSettings({ section }: { section: SettingsSection }) {
  const content: [string, string] = section === "tools"
    ? ["工具与 MCP", "规划对内置工具、MCP 服务和模式能力进行启用、禁用及优先级配置。"]
    : section === "tasks"
      ? ["后台任务", "规划配置工具升级阈值、并发上限、任务保留时间和完成通知。"]
      : ["权限与安全", "规划配置工作区沙箱、读取范围、危险操作确认策略和审计记录。"];
  return <SettingsModule eyebrow="PLANNED" title={content[0]} description={content[1]}><div className="planned-card"><span>建设中</span><p>菜单结构已经预留，后续接入真实运行时配置后再开放编辑。</p></div></SettingsModule>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
