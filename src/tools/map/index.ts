import type { MapCommandBridge } from "../../runtime/map-command-bridge.js";
import type { MapStateStore } from "../../runtime/map-state-store.js";
import type { ToolSpec } from "../core/contracts/tool-spec.js";

export interface MapToolDependencies {
  getSessionId: () => string;
  mapStateStore: MapStateStore;
  mapCommandBridge: MapCommandBridge;
}

/** Model-facing Web map tools. Internal browser commands remain deliberately fine-grained. */
export function createMapTools(deps: MapToolDependencies): ToolSpec[] {
  return [
    createGetMapStateTool(deps),
    createInspectMapLayerTool(deps),
    createManageMapLayerTool(deps),
    createControlMapViewTool(deps),
  ];
}

function createGetMapStateTool(deps: MapToolDependencies): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "map_get_state",
        description: "Read the active Web map state, including viewport, loaded layers, visualization summaries, and selected feature metadata. A separate layer-list tool is unnecessary.",
        parameters: {
          type: "object",
          properties: {
            include: {
              type: "array",
              items: { type: "string", enum: ["viewport", "layers", "selection"] },
              description: "Optional state sections to return. Omit to return all sections.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (input) => {
      const sessionId = deps.getSessionId();
      const state = deps.mapStateStore.get(sessionId);
      if (!state || !deps.mapStateStore.isActive(sessionId)) throw new Error("No active Web map state is available for this session.");
      if (!deps.mapCommandBridge.hasClient(sessionId, state.clientId)) {
        throw new Error(`The Web map client that reported the current state is no longer connected: ${state.clientId}`);
      }
      const include = readInclude(asRecord(input).include);
      const result: Record<string, unknown> = {
        sessionId: state.sessionId,
        clientId: state.clientId,
        revision: state.revision,
        updatedAt: state.updatedAt,
      };
      if (include.has("viewport")) result.viewport = { center: state.center, zoom: state.zoom, bounds: state.bounds, bearing: state.bearing, pitch: state.pitch };
      if (include.has("layers")) result.layers = state.layers ?? [];
      if (include.has("selection")) result.selection = state.selection ?? null;
      return JSON.stringify(result, null, 2);
    },
    metadata: {
      source: "map",
      supportedModes: ["web"],
      requiredCapabilities: ["map_view", "map_layers"],
      isAvailable: () => {
        const sessionId = deps.getSessionId();
        const state = deps.mapStateStore.get(sessionId);
        return Boolean(
          state &&
          deps.mapStateStore.isActive(sessionId) &&
          deps.mapCommandBridge.hasClient(sessionId, state.clientId),
        );
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      interruptBehavior: "cancel",
      getActivityDescription: () => "Reading the current Web map state",
      getToolUseSummary: () => "Read map viewport, layers, and selection",
      maxResultSizeChars: 30_000,
    },
  };
}

function createInspectMapLayerTool(deps: MapToolDependencies): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "map_inspect_layer",
        description: "Inspect one loaded Web map layer before visualization. Returns geometry types, feature count, field types, numeric ranges, and bounded unique-value samples without returning the complete dataset.",
        parameters: {
          type: "object",
          properties: {
            layer: { type: "string", description: "Layer id or exact layer name." },
            maxUniqueValues: { type: "integer", minimum: 2, maximum: 50, description: "Maximum unique values retained per field. Defaults to 12." },
          },
          required: ["layer"],
          additionalProperties: false,
        },
      },
    },
    handler: async (input, context) => {
      const args = asRecord(input);
      const result = await deps.mapCommandBridge.execute(
        deps.getSessionId(),
        "inspect_layer",
        {
          layer: readString(args.layer, "layer"),
          maxUniqueValues: args.maxUniqueValues === undefined ? 12 : readInteger(args.maxUniqueValues, "maxUniqueValues", 2, 50),
        },
        commandOptions(deps, 30_000, context?.signal),
      );
      return JSON.stringify(result, null, 2);
    },
    metadata: {
      ...commandMetadata(deps, () => "Inspecting a Web map layer", (input) => `Inspect layer ${typeof input.layer === "string" ? input.layer : ""}`.trim()),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 30_000,
    },
  };
}

function createManageMapLayerTool(deps: MapToolDependencies): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "map_manage_layer",
        description: "Manage Web map layers through one operation-based interface. Add/remove/update layers; style vectors and rasters; render DEM terrain; and add positioned glTF/GLB/OBJ models or georeferenced 3D Tiles. A standalone model requires placement. Use map_inspect_layer first when fields, bands, or value ranges are unknown.",
        parameters: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["add", "remove", "update", "visualize"] },
            layer: { type: "string", description: "Layer id or exact name for remove, update, and visualize." },
            source: {
              type: "object",
              description: "Required for add.",
              properties: {
                path: { type: "string", description: "Absolute or project-relative geospatial, 3D model, or local tileset.json path. Use either path or url." },
                url: { type: "string", description: "HTTP(S) URL for a glTF/GLB/OBJ model or 3D Tiles tileset.json. Use either path or url." },
                type: { type: "string", enum: ["model", "tiles3d"], description: "Required as tiles3d for tileset JSON; optional for .gltf, .glb, or .obj." },
                layerName: { type: "string", description: "Optional internal layer name for a multi-layer GPKG." },
                placement: {
                  type: "object",
                  description: "Required for model sources. Coordinates are WGS84; rotation is [x,y,z] degrees; model units are treated as meters before scale.",
                  properties: {
                    longitude: { type: "number", minimum: -180, maximum: 180 },
                    latitude: { type: "number", minimum: -85.05112878, maximum: 85.05112878 },
                    altitude: { type: "number", description: "Height in meters. Defaults to 0." },
                    scale: { type: "number", exclusiveMinimum: 0, maximum: 1000000, description: "Uniform scale. Defaults to 1." },
                    rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "Euler rotation [x,y,z] in degrees." },
                  },
                  required: ["longitude", "latitude"],
                  additionalProperties: false,
                },
                offset: {
                  type: "object",
                  description: "Optional 3D Tiles correction in meters.",
                  properties: {
                    east: { type: "number" },
                    up: { type: "number" },
                    south: { type: "number" },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
            options: {
              type: "object",
              properties: { fit: { type: "boolean", description: "Zoom to a newly added layer. Defaults to true." } },
              additionalProperties: false,
            },
            changes: {
              type: "object",
              description: "Required for update; include visible, opacity, or both.",
              properties: {
                visible: { type: "boolean" },
                opacity: { type: "number", minimum: 0, maximum: 1 },
              },
              additionalProperties: false,
            },
            visualization: {
              type: "object",
              description: "Required for visualize.",
              properties: {
                mode: { type: "string", enum: ["simple", "categorical", "graduated", "grayscale", "rgb", "color_relief", "hillshade", "terrain"] },
                field: { type: "string", description: "Required for categorical and graduated modes." },
                band: { type: "integer", minimum: 1, description: "Raster band for grayscale, color_relief, hillshade, or terrain. DEM terrain normally uses band 1." },
                bands: {
                  type: "object",
                  description: "Raster band mapping for RGB mode. Defaults to red=1, green=2, blue=3.",
                  properties: {
                    red: { type: "integer", minimum: 1 },
                    green: { type: "integer", minimum: 1 },
                    blue: { type: "integer", minimum: 1 },
                  },
                  required: ["red", "green", "blue"],
                  additionalProperties: false,
                },
                minimum: { type: "number", description: "Optional raster stretch or color-relief minimum." },
                maximum: { type: "number", description: "Optional raster stretch or color-relief maximum." },
                zFactor: { type: "number", exclusiveMinimum: 0, description: "Hillshade vertical exaggeration. Defaults to 1." },
                scale: { type: "number", exclusiveMinimum: 0, description: "Hillshade horizontal-to-vertical unit scale. Defaults to 111120 for the EPSG:4326 display raster." },
                azimuth: { type: "number", minimum: 0, maximum: 360, description: "Hillshade light azimuth. Defaults to 315." },
                altitude: { type: "number", minimum: 0, maximum: 90, description: "Hillshade light altitude. Defaults to 45." },
                multidirectional: { type: "boolean", description: "Use multidirectional hillshade." },
                exaggeration: { type: "number", minimum: 0, maximum: 20, description: "Vertical exaggeration for terrain mode. Defaults to 1.5; 1 means true scale." },
                color: { type: "string", description: "Six-digit CSS hex fallback or simple color." },
                palette: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 12 },
                classes: { type: "integer", minimum: 2, maximum: 9 },
                classification: { type: "string", enum: ["quantile", "equal_interval"] },
                opacity: { type: "number", minimum: 0, maximum: 1 },
                pointRadius: { type: "number", minimum: 1, maximum: 30 },
                lineWidth: { type: "number", minimum: 0.5, maximum: 20 },
                title: { type: "string" },
              },
              required: ["mode"],
              additionalProperties: false,
            },
          },
          required: ["operation"],
          additionalProperties: false,
        },
      },
    },
    handler: async (input, context) => {
      const args = asRecord(input);
      const operation = readEnum(args.operation, "operation", ["add", "remove", "update", "visualize"] as const);
      let command: "add_layer" | "remove_layer" | "update_layer" | "visualize_layer";
      let payload: Record<string, unknown>;
      let timeoutMs = 30_000;
      if (operation === "add") {
        const source = readRecord(args.source, "source");
        const options = readOptionalRecord(args.options, "options");
        const path = source.path === undefined ? undefined : readString(source.path, "source.path");
        const url = source.url === undefined ? undefined : readString(source.url, "source.url");
        if (Boolean(path) === Boolean(url)) throw new Error("source must include exactly one of path or url.");
        const sourceType = source.type === undefined ? undefined : readEnum(source.type, "source.type", ["model", "tiles3d"] as const);
        const placement = source.placement === undefined ? undefined : readRecord(source.placement, "source.placement");
        const offset = source.offset === undefined ? undefined : readRecord(source.offset, "source.offset");
        command = "add_layer";
        payload = {
          ...(path ? { path } : {}),
          ...(url ? { url } : {}),
          ...(sourceType ? { sourceType } : {}),
          ...(source.layerName !== undefined ? { layerName: readString(source.layerName, "source.layerName") } : {}),
          ...(placement ? { placement: {
            longitude: readNumber(placement.longitude, "source.placement.longitude", -180, 180),
            latitude: readNumber(placement.latitude, "source.placement.latitude", -85.05112878, 85.05112878),
            ...(placement.altitude !== undefined ? { altitude: readFiniteNumber(placement.altitude, "source.placement.altitude") } : {}),
            ...(placement.scale !== undefined ? { scale: readNumber(placement.scale, "source.placement.scale", 0.000001, 1_000_000) } : {}),
            ...(placement.rotation !== undefined ? { rotation: readNumberTuple(placement.rotation, "source.placement.rotation", 3) } : {}),
          } } : {}),
          ...(offset ? { offset: {
            ...(offset.east !== undefined ? { east: readFiniteNumber(offset.east, "source.offset.east") } : {}),
            ...(offset.up !== undefined ? { up: readFiniteNumber(offset.up, "source.offset.up") } : {}),
            ...(offset.south !== undefined ? { south: readFiniteNumber(offset.south, "source.offset.south") } : {}),
          } } : {}),
          fit: options.fit === undefined ? true : readBoolean(options.fit, "options.fit"),
        };
        timeoutMs = 10 * 60_000;
      } else if (operation === "remove") {
        command = "remove_layer";
        payload = { layer: readString(args.layer, "layer") };
      } else if (operation === "update") {
        const changes = readRecord(args.changes, "changes");
        if (changes.visible === undefined && changes.opacity === undefined) throw new Error("changes must include visible or opacity.");
        command = "update_layer";
        payload = {
          layer: readString(args.layer, "layer"),
          changes: {
            ...(changes.visible !== undefined ? { visible: readBoolean(changes.visible, "changes.visible") } : {}),
            ...(changes.opacity !== undefined ? { opacity: readNumber(changes.opacity, "changes.opacity", 0, 1) } : {}),
          },
        };
      } else {
        command = "visualize_layer";
        const visualization = readRecord(args.visualization, "visualization");
        const mode = readEnum(visualization.mode, "visualization.mode", ["simple", "categorical", "graduated", "grayscale", "rgb", "color_relief", "hillshade", "terrain"] as const);
        const field = visualization.field === undefined ? undefined : readString(visualization.field, "visualization.field");
        if ((mode === "categorical" || mode === "graduated") && !field) throw new Error(`${mode} visualization requires visualization.field.`);
        const bands = visualization.bands === undefined ? undefined : readRecord(visualization.bands, "visualization.bands");
        payload = {
          layer: readString(args.layer, "layer"),
          mode,
          ...(field ? { field } : {}),
          ...(visualization.color !== undefined ? { color: readHexColor(visualization.color, "visualization.color") } : {}),
          ...(visualization.palette !== undefined ? { palette: readColorArray(visualization.palette) } : {}),
          ...(visualization.band !== undefined ? { band: readInteger(visualization.band, "visualization.band", 1, 10_000) } : {}),
          ...(bands ? { bands: {
            red: readInteger(bands.red, "visualization.bands.red", 1, 10_000),
            green: readInteger(bands.green, "visualization.bands.green", 1, 10_000),
            blue: readInteger(bands.blue, "visualization.bands.blue", 1, 10_000),
          } } : {}),
          ...(visualization.minimum !== undefined ? { minimum: readFiniteNumber(visualization.minimum, "visualization.minimum") } : {}),
          ...(visualization.maximum !== undefined ? { maximum: readFiniteNumber(visualization.maximum, "visualization.maximum") } : {}),
          ...(visualization.zFactor !== undefined ? { zFactor: readNumber(visualization.zFactor, "visualization.zFactor", 0.000001, Number.MAX_SAFE_INTEGER) } : {}),
          ...(visualization.scale !== undefined ? { scale: readNumber(visualization.scale, "visualization.scale", 0.000001, Number.MAX_SAFE_INTEGER) } : {}),
          ...(visualization.azimuth !== undefined ? { azimuth: readNumber(visualization.azimuth, "visualization.azimuth", 0, 360) } : {}),
          ...(visualization.altitude !== undefined ? { altitude: readNumber(visualization.altitude, "visualization.altitude", 0, 90) } : {}),
          ...(visualization.multidirectional !== undefined ? { multidirectional: readBoolean(visualization.multidirectional, "visualization.multidirectional") } : {}),
          ...(visualization.exaggeration !== undefined ? { exaggeration: readNumber(visualization.exaggeration, "visualization.exaggeration", 0, 20) } : {}),
          classes: visualization.classes === undefined ? 5 : readInteger(visualization.classes, "visualization.classes", 2, 9),
          classification: visualization.classification === undefined ? "quantile" : readEnum(visualization.classification, "visualization.classification", ["quantile", "equal_interval"] as const),
          opacity: visualization.opacity === undefined ? 0.78 : readNumber(visualization.opacity, "visualization.opacity", 0, 1),
          pointRadius: visualization.pointRadius === undefined ? 6 : readNumber(visualization.pointRadius, "visualization.pointRadius", 1, 30),
          lineWidth: visualization.lineWidth === undefined ? 3 : readNumber(visualization.lineWidth, "visualization.lineWidth", 0.5, 20),
          ...(visualization.title !== undefined ? { title: readString(visualization.title, "visualization.title").slice(0, 100) } : {}),
        };
        if (["grayscale", "rgb", "color_relief", "hillshade", "terrain"].includes(mode)) {
          timeoutMs = 10 * 60_000;
        }
      }
      const result = await deps.mapCommandBridge.execute(
        deps.getSessionId(),
        command,
        payload,
        commandOptions(deps, timeoutMs, context?.signal),
      );
      return JSON.stringify(result, null, 2);
    },
    metadata: {
      ...commandMetadata(
        deps,
        (input) => `Managing Web map layer (${typeof input.operation === "string" ? input.operation : "operation"})`,
        (input) => `${typeof input.operation === "string" ? input.operation : "Manage"} map layer`,
      ),
      getReadPaths: (input) => getAddSourcePath(input),
    },
  };
}

function createControlMapViewTool(deps: MapToolDependencies): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "map_control_view",
        description: "Control the active Web map viewport. Set an explicit center/view or fit the viewport to a loaded layer.",
        parameters: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["set", "fit"] },
            view: {
              type: "object",
              description: "Required for set.",
              properties: {
                center: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
                zoom: { type: "number", minimum: 0, maximum: 24 },
                bearing: { type: "number", minimum: -360, maximum: 360 },
                pitch: { type: "number", minimum: 0, maximum: 85 },
              },
              required: ["center"],
              additionalProperties: false,
            },
            target: {
              type: "object",
              description: "Required for fit.",
              properties: { layer: { type: "string", description: "Layer id or exact layer name." } },
              required: ["layer"],
              additionalProperties: false,
            },
            options: {
              type: "object",
              properties: {
                padding: { type: "number", minimum: 0, maximum: 300 },
                maxZoom: { type: "number", minimum: 0, maximum: 24 },
                durationMs: { type: "integer", minimum: 0, maximum: 10_000 },
              },
              additionalProperties: false,
            },
          },
          required: ["operation"],
          additionalProperties: false,
        },
      },
    },
    handler: async (input, context) => {
      const args = asRecord(input);
      const operation = readEnum(args.operation, "operation", ["set", "fit"] as const);
      const options = readOptionalRecord(args.options, "options");
      const durationMs = options.durationMs === undefined ? (operation === "set" ? 600 : 700) : readInteger(options.durationMs, "options.durationMs", 0, 10_000);
      const payload: Record<string, unknown> = { durationMs };
      const command = operation === "set" ? "set_view" : "fit_layer";
      if (operation === "set") {
        const view = readRecord(args.view, "view");
        payload.center = readCoordinate(view.center);
        if (view.zoom !== undefined) payload.zoom = readNumber(view.zoom, "view.zoom", 0, 24);
        if (view.bearing !== undefined) payload.bearing = readNumber(view.bearing, "view.bearing", -360, 360);
        if (view.pitch !== undefined) payload.pitch = readNumber(view.pitch, "view.pitch", 0, 85);
      } else {
        const target = readRecord(args.target, "target");
        payload.layer = readString(target.layer, "target.layer");
        payload.padding = options.padding === undefined ? 70 : readNumber(options.padding, "options.padding", 0, 300);
        payload.maxZoom = options.maxZoom === undefined ? 14 : readNumber(options.maxZoom, "options.maxZoom", 0, 24);
      }
      const result = await deps.mapCommandBridge.execute(
        deps.getSessionId(),
        command,
        payload,
        commandOptions(deps, durationMs + 10_000, context?.signal),
      );
      return JSON.stringify(result, null, 2);
    },
    metadata: commandMetadata(
      deps,
      (input) => `Controlling Web map view (${typeof input.operation === "string" ? input.operation : "operation"})`,
      (input) => `${typeof input.operation === "string" ? input.operation : "Control"} map view`,
    ),
  };
}

function commandMetadata(
  deps: MapToolDependencies,
  getActivityDescription: (input: Record<string, unknown>) => string,
  getToolUseSummary: (input: Record<string, unknown>) => string,
): NonNullable<ToolSpec["metadata"]> {
  return {
    source: "map",
    supportedModes: ["web"],
    requiredCapabilities: ["map_commands"],
    isAvailable: () => {
      const sessionId = deps.getSessionId();
      const state = deps.mapStateStore.get(sessionId);
      return Boolean(
        state &&
        deps.mapStateStore.isActive(sessionId) &&
        deps.mapCommandBridge.hasClient(sessionId, state.clientId),
      );
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    interruptBehavior: "cancel",
    getActivityDescription: (input) => getActivityDescription(asRecordOrEmpty(input)),
    getToolUseSummary: (input) => getToolUseSummary(asRecordOrEmpty(input)),
  };
}

function commandOptions(
  deps: MapToolDependencies,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): { timeoutMs: number; signal?: AbortSignal; clientId: string } {
  const sessionId = deps.getSessionId();
  const state = deps.mapStateStore.get(sessionId);
  if (!state || !deps.mapStateStore.isActive(sessionId)) {
    throw new Error("No active Web map state is available for this session.");
  }
  if (!deps.mapCommandBridge.hasClient(sessionId, state.clientId)) {
    throw new Error(`The Web map client that reported the current state is no longer connected: ${state.clientId}`);
  }
  return {
    timeoutMs,
    ...(signal ? { signal } : {}),
    clientId: state.clientId,
  };
}

function getAddSourcePath(input: unknown): string | undefined {
  const args = asRecordOrEmpty(input);
  if (args.operation !== "add") return undefined;
  const source = asRecordOrEmpty(args.source);
  return typeof source.path === "string" && source.path.trim() ? source.path.trim() : undefined;
}

function readInclude(value: unknown): Set<"viewport" | "layers" | "selection"> {
  if (value === undefined) return new Set(["viewport", "layers", "selection"]);
  if (!Array.isArray(value) || value.length === 0) throw new Error("include must be a non-empty array when provided.");
  return new Set(value.map((entry) => readEnum(entry, "include item", ["viewport", "layers", "selection"] as const)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Map tool input must be an object.");
  return value as Record<string, unknown>;
}

function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function readOptionalRecord(value: unknown, name: string): Record<string, unknown> {
  return value === undefined ? {} : readRecord(value, name);
}

function readCoordinate(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("view.center must be [longitude, latitude].");
  return [readNumber(value[0], "longitude", -180, 180), readNumber(value[1], "latitude", -90, 90)];
}

function readNumberTuple(value: unknown, name: string, length: 3): [number, number, number] {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`${name} must contain exactly ${length} numbers.`);
  return value.map((entry, index) => readFiniteNumber(entry, `${name}[${index}]`)) as [number, number, number];
}

function readNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be a number between ${minimum} and ${maximum}.`);
  return value;
}

function readFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function readInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const number = readNumber(value, name, minimum, maximum);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer.`);
  return number;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function readEnum<const T extends readonly string[]>(value: unknown, name: string, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}.`);
  return value as T[number];
}

function readHexColor(value: unknown, name: string): string {
  const color = readString(value, name);
  if (!/^#[0-9a-f]{6}$/iu.test(color)) throw new Error(`${name} must be a six-digit CSS hex color such as #2563eb.`);
  return color;
}

function readColorArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 12) throw new Error("visualization.palette must contain between 2 and 12 colors.");
  return value.map((color, index) => readHexColor(color, `visualization.palette[${index}]`));
}
