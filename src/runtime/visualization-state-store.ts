export type VisualizationKind =
  | "map"
  | "markdown"
  | "html"
  | "csv"
  | "json"
  | "text"
  | "image";

export interface VisualizationTabState {
  id: string;
  kind: VisualizationKind;
  title: string;
  sourcePath?: string;
  artifactId?: string;
  closable: boolean;
}

export interface VisualizationStateUpdate {
  clientId: string;
  activeTabId: string;
  tabs: VisualizationTabState[];
}

export interface VisualizationStateSnapshot extends VisualizationStateUpdate {
  sessionId: string;
  revision: number;
  updatedAt: string;
}

const ACTIVE_WINDOW_MS = 45_000;

/** Stores only open-view metadata; file contents never enter this store or the prompt. */
export class VisualizationStateStore {
  private readonly states = new Map<string, VisualizationStateSnapshot>();

  update(sessionId: string, input: VisualizationStateUpdate): VisualizationStateSnapshot {
    const previous = this.states.get(sessionId);
    const tabs = input.tabs.slice(0, 30).map((tab) => ({
      id: tab.id.slice(0, 300),
      kind: tab.kind,
      title: tab.title.slice(0, 200),
      ...(tab.sourcePath ? { sourcePath: tab.sourcePath.slice(0, 1_000) } : {}),
      ...(tab.artifactId ? { artifactId: tab.artifactId.slice(0, 300) } : {}),
      closable: tab.kind === "map" ? false : tab.closable,
    }));
    const activeTabId = tabs.some((tab) => tab.id === input.activeTabId)
      ? input.activeTabId
      : tabs[0]?.id ?? "map";
    const snapshot: VisualizationStateSnapshot = {
      sessionId,
      clientId: input.clientId,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      activeTabId,
      tabs,
    };
    this.states.set(sessionId, snapshot);
    return structuredClone(snapshot);
  }

  get(sessionId: string): VisualizationStateSnapshot | undefined {
    const state = this.states.get(sessionId);
    return state ? structuredClone(state) : undefined;
  }

  removeClient(sessionId: string, clientId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state || state.clientId !== clientId) return false;
    return this.states.delete(sessionId);
  }

  removeSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  isActive(sessionId: string, now = Date.now()): boolean {
    const state = this.states.get(sessionId);
    return Boolean(state && now - Date.parse(state.updatedAt) <= ACTIVE_WINDOW_MS);
  }

  formatPromptSummary(sessionId: string): string | undefined {
    const state = this.states.get(sessionId);
    if (!state || !this.isActive(sessionId)) return undefined;
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    return [
      `Current visualization workspace (revision ${state.revision}):`,
      `- active view: ${active ? `${active.title} [${active.kind}]` : "none"}`,
      `- open views: ${state.tabs.length === 0 ? "none" : state.tabs.map((tab) => `${tab.title} [${tab.kind}]${tab.id === state.activeTabId ? " (active)" : ""}`).join(", ")}`,
      ...state.tabs
        .filter((tab) => tab.sourcePath)
        .map((tab) => `- source metadata: ${tab.title} -> ${tab.sourcePath}`),
      "Visualization contents are intentionally omitted; use file or data tools when content is needed.",
    ].join("\n");
  }
}
