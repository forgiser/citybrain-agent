import type { MapCommandBridge } from "../../runtime/map-command-bridge.js";
import type { MapStateStore } from "../../runtime/map-state-store.js";
import type { ToolSpec } from "../core/contracts/tool-spec.js";

export interface MapToolDependencies {
  getSessionId: () => string;
  mapStateStore: MapStateStore;
  mapCommandBridge: MapCommandBridge;
}

export function createMapTools(deps: MapToolDependencies): ToolSpec[] {
  return [
    createGetMapStateTool(deps),
    createListMapLayersTool(deps),
    createAddMapLayerTool(deps),
    createRemoveMapLayerTool(deps),
    createSetMapLayerVisibilityTool(deps),
    createSetMapViewTool(deps),
    createFitMapLayerTool(deps),
  ];
}

function createListMapLayersTool(deps: MapToolDependencies): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "map_list_layers",
        description: "List layers currently loaded in the active Web UI map, including visibility and format.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    handler: async () => {
      const sessionId = deps.getSessionId();
      const state = deps.mapStateStore.get(sessionId);
      if (!state || !deps.mapStateStore.isActive(sessionId)) {
        throw new Error("No active Web map state is available for this session.");
      }
      return JSON.stringify({ layers: state.layers ?? [] }, null, 2);
    },
    metadata: {
      source: "map",
      supportedModes: ["web"],
      requiredCapabilities: ["map_layers"],
      isAvailable: () => deps.mapStateStore.isActive(deps.getSessionId()),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      interruptBehavior: "cancel",
      getActivityDescription: () => "Listing Web map layers",
      getToolUseSummary: () => "List loaded map layers",
      maxResultSizeChars: 20_000,
    },
  };
}

function createAddMapLayerTool(deps: MapToolDependencies): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "map_add_layer",
        description: "Explicitly add a local vector file to the active Web UI map. Supports GeoJSON, SHP, GPKG, KML, and GML; files are never added automatically.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or project-relative path to a GeoJSON, SHP, GPKG, KML, or GML file." },
            fit: { type: "boolean", description: "Whether to zoom to the layer after adding it. Defaults to true." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    handler: async (input, context) => {
      const args = asRecord(input);
      const path = readString(args.path, "path");
      const fit = args.fit === undefined ? true : readBoolean(args.fit, "fit");
      const result = await deps.mapCommandBridge.execute(
        deps.getSessionId(),
        "add_layer",
        { path, fit },
        { timeoutMs: 10 * 60_000, signal: context?.signal },
      );
      return JSON.stringify(result, null, 2);
    },
    metadata: {
      ...mapCommandMetadata(
        deps,
        () => "Preparing and adding a vector layer to the Web map",
        (input) => `Add ${typeof input.path === "string" ? input.path : "vector layer"} to map`,
      ),
      getReadPaths: (input) => readString(asRecord(input).path, "path"),
    },
  };
}

function createRemoveMapLayerTool(deps: MapToolDependencies): ToolSpec {
  return createLayerCommandTool(
    deps,
    "map_remove_layer",
    "Remove a loaded layer from the active Web UI map without deleting its source file.",
    "remove_layer",
    "Removing a layer from the Web map",
  );
}

function createSetMapLayerVisibilityTool(deps: MapToolDependencies): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "map_set_layer_visibility",
        description: "Show or hide a loaded layer in the active Web UI map.",
        parameters: {
          type: "object",
          properties: {
            layer: { type: "string", description: "Artifact id or exact layer name." },
            visible: { type: "boolean" },
          },
          required: ["layer", "visible"],
          additionalProperties: false,
        },
      },
    },
    handler: async (input, context) => {
      const args = asRecord(input);
      const layer = readString(args.layer, "layer");
      const visible = readBoolean(args.visible, "visible");
      const result = await deps.mapCommandBridge.execute(
        deps.getSessionId(),
        "set_layer_visibility",
        { layer, visible },
        { timeoutMs: 10_000, signal: context?.signal },
      );
      return JSON.stringify(result, null, 2);
    },
    metadata: mapCommandMetadata(
      deps,
      () => "Changing Web map layer visibility",
      (input) => `${input.visible === false ? "Hide" : "Show"} layer ${typeof input.layer === "string" ? input.layer : ""}`.trim(),
    ),
  };
}

function createLayerCommandTool(
  deps: MapToolDependencies,
  name: string,
  description: string,
  command: "remove_layer",
  activity: string,
): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties: { layer: { type: "string", description: "Artifact id or exact layer name." } },
          required: ["layer"],
          additionalProperties: false,
        },
      },
    },
    handler: async (input, context) => {
      const layer = readString(asRecord(input).layer, "layer");
      const result = await deps.mapCommandBridge.execute(
        deps.getSessionId(), command, { layer }, { timeoutMs: 10_000, signal: context?.signal },
      );
      return JSON.stringify(result, null, 2);
    },
    metadata: mapCommandMetadata(
      deps,
      () => activity,
      (input) => `Remove layer ${typeof input.layer === "string" ? input.layer : ""}`.trim(),
    ),
  };
}

function createGetMapStateTool(deps: MapToolDependencies): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "map_get_state",
        description: "Read the current Web UI map viewport, visible layers, and selected feature summary.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    handler: async () => {
      const sessionId = deps.getSessionId();
      const state = deps.mapStateStore.get(sessionId);
      if (!state || !deps.mapStateStore.isActive(sessionId)) {
        throw new Error("No active Web map state is available for this session.");
      }
      return JSON.stringify(state, null, 2);
    },
    metadata: {
      source: "map",
      supportedModes: ["web"],
      requiredCapabilities: ["map_view"],
      isAvailable: () => deps.mapStateStore.isActive(deps.getSessionId()),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      interruptBehavior: "cancel",
      getActivityDescription: () => "Reading the current map state",
      getToolUseSummary: () => "Read map viewport and layer state",
      maxResultSizeChars: 20_000,
    },
  };
}

function createSetMapViewTool(deps: MapToolDependencies): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "map_set_view",
        description: "Move the active Web UI map to a center and optional zoom, bearing, and pitch.",
        parameters: {
          type: "object",
          properties: {
            center: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
              description: "Map center as [longitude, latitude].",
            },
            zoom: { type: "number", minimum: 0, maximum: 24 },
            bearing: { type: "number", minimum: -360, maximum: 360 },
            pitch: { type: "number", minimum: 0, maximum: 85 },
            durationMs: { type: "integer", minimum: 0, maximum: 10_000 },
          },
          required: ["center"],
          additionalProperties: false,
        },
      },
    },
    handler: async (input, context) => {
      const args = asRecord(input);
      const center = readCoordinate(args.center);
      const payload = {
        center,
        ...(args.zoom !== undefined ? { zoom: readNumber(args.zoom, "zoom", 0, 24) } : {}),
        ...(args.bearing !== undefined ? { bearing: readNumber(args.bearing, "bearing", -360, 360) } : {}),
        ...(args.pitch !== undefined ? { pitch: readNumber(args.pitch, "pitch", 0, 85) } : {}),
        durationMs: args.durationMs === undefined
          ? 600
          : readInteger(args.durationMs, "durationMs", 0, 10_000),
      };
      const result = await deps.mapCommandBridge.execute(
        deps.getSessionId(),
        "set_view",
        payload,
        { timeoutMs: payload.durationMs + 5_000, signal: context?.signal },
      );
      return JSON.stringify(result, null, 2);
    },
    metadata: mapCommandMetadata(
      deps,
      () => "Moving the Web map",
      (input) => {
        const center = Array.isArray(input.center) ? input.center.join(", ") : "requested location";
        return `Move map to ${center}`;
      },
    ),
  };
}

function createFitMapLayerTool(deps: MapToolDependencies): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "map_fit_layer",
        description: "Fit the active Web UI map viewport to a loaded map layer, identified by artifact id or exact layer name.",
        parameters: {
          type: "object",
          properties: {
            layer: { type: "string", description: "Artifact id or exact layer name." },
            padding: { type: "number", minimum: 0, maximum: 300 },
            maxZoom: { type: "number", minimum: 0, maximum: 24 },
            durationMs: { type: "integer", minimum: 0, maximum: 10_000 },
          },
          required: ["layer"],
          additionalProperties: false,
        },
      },
    },
    handler: async (input, context) => {
      const args = asRecord(input);
      const layer = readString(args.layer, "layer");
      const durationMs = args.durationMs === undefined
        ? 700
        : readInteger(args.durationMs, "durationMs", 0, 10_000);
      const result = await deps.mapCommandBridge.execute(
        deps.getSessionId(),
        "fit_layer",
        {
          layer,
          padding: args.padding === undefined
            ? 70
            : readNumber(args.padding, "padding", 0, 300),
          maxZoom: args.maxZoom === undefined
            ? 14
            : readNumber(args.maxZoom, "maxZoom", 0, 24),
          durationMs,
        },
        { timeoutMs: durationMs + 10_000, signal: context?.signal },
      );
      return JSON.stringify(result, null, 2);
    },
    metadata: mapCommandMetadata(
      deps,
      () => "Fitting the Web map to a layer",
      (input) => `Zoom to layer ${typeof input.layer === "string" ? input.layer : ""}`.trim(),
    ),
  };
}

function mapCommandMetadata(
  deps: MapToolDependencies,
  getActivityDescription: () => string,
  getToolUseSummary: (input: Record<string, unknown>) => string,
): NonNullable<ToolSpec["metadata"]> {
  return {
    source: "map",
    supportedModes: ["web"],
    requiredCapabilities: ["map_commands"],
    isAvailable: () => deps.mapCommandBridge.hasActiveClient(deps.getSessionId()),
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    interruptBehavior: "cancel",
    getActivityDescription,
    getToolUseSummary: (input) => getToolUseSummary(asRecordOrEmpty(input)),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Map tool input must be an object.");
  }
  return value as Record<string, unknown>;
}

function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readCoordinate(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("center must be [longitude, latitude].");
  }
  return [
    readNumber(value[0], "longitude", -180, 180),
    readNumber(value[1], "latitude", -90, 90),
  ];
}

function readNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function readInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const number = readNumber(value, name, minimum, maximum);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer.`);
  return number;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}
