export interface MapLayerState {
  id: string;
  name: string;
  visible: boolean;
  format?: string;
}

export interface MapSelectionState {
  layerId: string;
  featureId?: string | number;
  geometryType?: string;
  properties?: Record<string, unknown>;
}

export interface MapStateUpdate {
  clientId: string;
  center: [number, number];
  zoom: number;
  bounds: [number, number, number, number];
  bearing?: number;
  pitch?: number;
  layers?: MapLayerState[];
  selection?: MapSelectionState;
}

export interface MapStateSnapshot extends MapStateUpdate {
  sessionId: string;
  revision: number;
  updatedAt: string;
}

const ACTIVE_CLIENT_WINDOW_MS = 45_000;

/** Keeps only compact, prompt-safe browser map state; spatial data stays in artifacts. */
export class MapStateStore {
  private readonly states = new Map<string, MapStateSnapshot>();

  update(sessionId: string, update: MapStateUpdate): MapStateSnapshot {
    const previous = this.states.get(sessionId);
    const snapshot: MapStateSnapshot = {
      sessionId,
      clientId: update.clientId,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      center: [...update.center],
      zoom: update.zoom,
      bounds: [...update.bounds],
      bearing: update.bearing ?? 0,
      pitch: update.pitch ?? 0,
      layers: (update.layers ?? []).slice(0, 100).map((layer) => ({ ...layer })),
      ...(update.selection
        ? { selection: sanitizeSelection(update.selection) }
        : {}),
    };
    this.states.set(sessionId, snapshot);
    return structuredClone(snapshot);
  }

  get(sessionId: string): MapStateSnapshot | undefined {
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
    if (!state) return false;
    return now - Date.parse(state.updatedAt) <= ACTIVE_CLIENT_WINDOW_MS;
  }

  formatPromptSummary(sessionId: string): string | undefined {
    const state = this.states.get(sessionId);
    if (!state || !this.isActive(sessionId)) return undefined;
    const layers = state.layers ?? [];
    const lines = [
      `Current map state (revision ${state.revision}, client ${state.clientId}):`,
      `- center: [${formatNumber(state.center[0])}, ${formatNumber(state.center[1])}]`,
      `- zoom: ${formatNumber(state.zoom)}; bearing: ${formatNumber(state.bearing ?? 0)}; pitch: ${formatNumber(state.pitch ?? 0)}`,
      `- bounds: [${state.bounds.map(formatNumber).join(", ")}]`,
      `- layers: ${layers.length === 0 ? "none" : layers.map((layer) => `${layer.id} (${layer.visible ? "visible" : "hidden"})`).join(", ")}`,
    ];
    if (state.selection) {
      lines.push(
        `- selection: layer=${state.selection.layerId}; feature=${String(state.selection.featureId ?? "unknown")}; geometry=${state.selection.geometryType ?? "unknown"}`,
      );
      const keys = Object.keys(state.selection.properties ?? {});
      if (keys.length > 0) lines.push(`- selected property keys: ${keys.join(", ")}`);
    } else {
      lines.push("- selection: none");
    }
    return lines.join("\n");
  }
}

function sanitizeSelection(selection: MapSelectionState): MapSelectionState {
  const properties = Object.fromEntries(
    Object.entries(selection.properties ?? {})
      .slice(0, 20)
      .map(([key, value]) => [key.slice(0, 100), sanitizeProperty(value)]),
  );
  return {
    layerId: selection.layerId,
    ...(selection.featureId !== undefined ? { featureId: selection.featureId } : {}),
    ...(selection.geometryType ? { geometryType: selection.geometryType } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}

function sanitizeProperty(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return String(value).slice(0, 500);
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? Number(value.toFixed(6)).toString() : "unknown";
}
