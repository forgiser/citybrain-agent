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

type SettingsSection = "models" | "agent" | "qgis" | "map" | "appearance" | "tools" | "tasks" | "security";

const MENU: Array<{ id: SettingsSection; label: string; description: string; planned?: boolean }> = [
  { id: "models", label: "模型服务", description: "服务商、API 与默认模型" },
  { id: "agent", label: "Agent", description: "推理与回答行为" },
  { id: "qgis", label: "QGIS", description: "空间处理运行环境" },
  { id: "map", label: "地图", description: "底图与图层行为" },
  { id: "appearance", label: "界面", description: "主题与显示偏好" },
  { id: "tools", label: "工具与 MCP", description: "工具来源和启用策略", planned: true },
  { id: "tasks", label: "后台任务", description: "并发、超时与通知", planned: true },
  { id: "security", label: "权限与安全", description: "沙箱和操作确认", planned: true },
];

export function SettingsPage({ settings, options: initialOptions, onChange, onOptionsChange, onBack }: {
  settings: WebSettings;
  options: SettingsOptions;
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
      <button className="save" onClick={() => void save()}>{saved ? "已保存" : "保存设置"}</button>
    </header>
    <div className="settings-layout">
      <nav className="settings-menu" aria-label="设置分类">
        {MENU.map((item) => <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => setSection(item.id)}>
          <span><strong>{item.label}</strong>{item.planned && <em>待集成</em>}</span>
          <small>{item.description}</small>
        </button>)}
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
        {(["tools", "tasks", "security"] as SettingsSection[]).includes(section) && <PlannedSettings section={section} />}
      </main>
    </div>
  </div>;
}

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
