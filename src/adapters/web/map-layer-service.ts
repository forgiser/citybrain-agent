import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { QgisRuntimeInfo } from "../../integrations/qgis/qgis-runtime.js";
import { executeQgisAlgorithm } from "../../integrations/qgis/qgis-process-client.js";
import type { SessionManager } from "../../session/session-manager.js";
import { SandboxPolicy } from "../../workspace/sandbox-policy.js";

const DIRECT_EXTENSIONS = new Set([".geojson", ".json"]);
const QGIS_VECTOR_EXTENSIONS = new Set([".shp", ".gpkg", ".kml", ".gml"]);
const QGIS_RASTER_EXTENSIONS = new Set([".tif", ".tiff", ".vrt", ".img", ".asc"]);

export type RasterImageCoordinates = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

export interface PreparedMapLayer {
  id: string;
  sessionId: string;
  name: string;
  sourcePath: string;
  sourceFormat: string;
  kind: "vector" | "raster";
  sourceCrs?: string;
  displayCrs: "EPSG:4326";
  status: "ready";
  contentType: "application/geo+json; charset=utf-8" | "image/png";
  sizeBytes: number;
  dataUrl: string;
  coordinates?: RasterImageCoordinates;
  cached: boolean;
  visible: boolean;
  opacity: number;
  order: number;
  style?: Record<string, unknown>;
}

interface InternalPreparedLayer extends PreparedMapLayer {
  displayPath: string;
  rasterPath?: string;
}

export interface PrepareMapLayerInput {
  path: string;
  name?: string;
  layerName?: string;
  sourceCrs?: string;
}

export interface RasterVisualizationInput {
  mode: "grayscale" | "rgb" | "color_relief" | "hillshade";
  band?: number;
  bands?: { red: number; green: number; blue: number };
  palette?: string[];
  minimum?: number;
  maximum?: number;
  zFactor?: number;
  scale?: number;
  azimuth?: number;
  altitude?: number;
  multidirectional?: boolean;
  opacity?: number;
  title?: string;
}

export class MapLayerService {
  private readonly layers = new Map<string, InternalPreparedLayer>();

  async prepare(
    session: SessionManager,
    input: PrepareMapLayerInput,
    qgisRuntime: QgisRuntimeInfo | undefined,
  ): Promise<PreparedMapLayer> {
    const sourcePath = resolve(session.getProjectDir(), input.path);
    const policy = SandboxPolicy.fromWorkspace(session.getWorkspaceDir(), session.getProjectDir());
    policy.assertReadable(sourcePath);
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      throw new Error(`Map source file does not exist: ${sourcePath}`);
    }
    const extension = extname(sourcePath).toLowerCase();
    const isRaster = QGIS_RASTER_EXTENSIONS.has(extension);
    if (!DIRECT_EXTENSIONS.has(extension) && !QGIS_VECTOR_EXTENSIONS.has(extension) && !isRaster) {
      throw new Error(`Unsupported map format: ${extension || "unknown"}. Supported: GeoJSON, SHP, GPKG, KML, GML, GeoTIFF, VRT, IMG, ASC.`);
    }
    const sourceStat = statSync(sourcePath);
    const cacheKey = createHash("sha256").update(JSON.stringify({
      sourcePath: sourcePath.toLowerCase(),
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      layerName: input.layerName ?? "",
      sourceCrs: input.sourceCrs ?? "",
      targetCrs: "EPSG:4326",
    })).digest("hex").slice(0, 24);
    const id = `map-layer-${createHash("sha256")
      .update(`${session.getSessionId()}:${cacheKey}`)
      .digest("hex")
      .slice(0, 24)}`;
    const existing = this.layers.get(id);
    if (existing) return toPublic(existing);

    let displayPath = sourcePath;
    let rasterPath: string | undefined;
    let cached = false;
    let coordinates: RasterImageCoordinates | undefined;
    if (isRaster) {
      if (!qgisRuntime) throw new Error("QGIS is required to prepare raster data for the Web map.");
      const cacheDir = join(session.getWorkspaceDir(), ".internal", "map-cache");
      mkdirSync(cacheDir, { recursive: true });
      const warpedPath = join(cacheDir, `${cacheKey}.tif`);
      rasterPath = warpedPath;
      displayPath = join(cacheDir, `${cacheKey}.png`);
      cached = true;
      if (!existsSync(displayPath) || !findWorldFile(displayPath)) {
        const warpResult = await executeQgisAlgorithm(qgisRuntime, "gdal:warpreproject", {
          INPUT: sourcePath,
          ...(input.sourceCrs?.trim() ? { SOURCE_CRS: input.sourceCrs.trim() } : {}),
          TARGET_CRS: "EPSG:4326",
          RESAMPLING: 1,
          MULTITHREADING: true,
          OUTPUT: warpedPath,
        });
        if (!warpResult.ok || !existsSync(warpedPath)) {
          throw new Error(`QGIS failed to reproject the raster layer: ${warpResult.stderrTail || warpResult.stdoutTail}`);
        }
        const translateResult = await executeQgisAlgorithm(qgisRuntime, "gdal:translate", {
          INPUT: warpedPath,
          DATA_TYPE: 1,
          EXTRA: "-scale -co WORLDFILE=YES",
          OUTPUT: displayPath,
        });
        if (!translateResult.ok || !existsSync(displayPath)) {
          throw new Error(`QGIS failed to create the Web raster image: ${translateResult.stderrTail || translateResult.stdoutTail}`);
        }
      }
      coordinates = readRasterCoordinates(displayPath);
    } else if (DIRECT_EXTENSIONS.has(extension)) {
      assertGeoJson(sourcePath);
    } else {
      if (!qgisRuntime) throw new Error("QGIS is required to prepare this vector format for the Web map.");
      const cacheDir = join(session.getWorkspaceDir(), ".internal", "map-cache");
      mkdirSync(cacheDir, { recursive: true });
      displayPath = join(cacheDir, `${cacheKey}.geojson`);
      cached = true;
      if (!existsSync(displayPath)) {
        const qgisInput = input.layerName ? `${sourcePath}|layername=${input.layerName}` : sourcePath;
        const result = await executeQgisAlgorithm(qgisRuntime, "native:reprojectlayer", {
          INPUT: qgisInput,
          TARGET_CRS: "EPSG:4326",
          OUTPUT: displayPath,
        });
        if (!result.ok || !existsSync(displayPath)) {
          throw new Error(`QGIS failed to prepare the map layer: ${result.stderrTail || result.stdoutTail}`);
        }
      }
      assertGeoJson(displayPath);
    }

    const displayStat = statSync(displayPath);
    const layer: InternalPreparedLayer = {
      id,
      sessionId: session.getSessionId(),
      name: input.name?.trim() || basename(sourcePath),
      sourcePath,
      sourceFormat: extension.slice(1) || "unknown",
      kind: isRaster ? "raster" : "vector",
      ...(input.sourceCrs?.trim() ? { sourceCrs: input.sourceCrs.trim() } : {}),
      displayCrs: "EPSG:4326",
      status: "ready",
      contentType: isRaster ? "image/png" : "application/geo+json; charset=utf-8",
      sizeBytes: displayStat.size,
      dataUrl: `/api/map/layers/${id}/data`,
      ...(coordinates ? { coordinates } : {}),
      cached,
      visible: true,
      opacity: 1,
      order: this.list(session.getSessionId()).length,
      displayPath,
      ...(rasterPath ? { rasterPath } : {}),
    };
    this.layers.set(id, layer);
    return toPublic(layer);
  }

  list(sessionId: string): PreparedMapLayer[] {
    return [...this.layers.values()]
      .filter((layer) => layer.sessionId === sessionId)
      .sort((left, right) => left.order - right.order)
      .map(toPublic);
  }

  getInternal(id: string): InternalPreparedLayer | undefined {
    return this.layers.get(id);
  }

  getData(id: string): { sessionId: string; path: string; contentType: string } | undefined {
    const layer = this.layers.get(id);
    return layer
      ? { sessionId: layer.sessionId, path: layer.displayPath, contentType: layer.contentType }
      : undefined;
  }

  update(sessionId: string, id: string, patch: Record<string, unknown>): PreparedMapLayer {
    const layer = this.require(sessionId, id);
    if (typeof patch.name === "string" && patch.name.trim()) layer.name = patch.name.trim().slice(0, 200);
    if (typeof patch.visible === "boolean") layer.visible = patch.visible;
    if (typeof patch.opacity === "number" && Number.isFinite(patch.opacity) && patch.opacity >= 0 && patch.opacity <= 1) layer.opacity = patch.opacity;
    if (typeof patch.order === "number" && Number.isSafeInteger(patch.order)) layer.order = patch.order;
    if (isRecord(patch.style)) layer.style = structuredClone(patch.style);
    return toPublic(layer);
  }

  async visualizeRaster(
    sessionId: string,
    id: string,
    input: RasterVisualizationInput,
    qgisRuntime: QgisRuntimeInfo | undefined,
  ): Promise<PreparedMapLayer> {
    const layer = this.require(sessionId, id);
    if (layer.kind !== "raster" || !layer.rasterPath) {
      throw new Error(`Layer is not a raster layer: ${id}`);
    }
    if (!qgisRuntime) throw new Error("QGIS is required to visualize raster data.");
    const style = normalizeRasterVisualization(input);
    const cacheDir = dirname(layer.rasterPath);
    const styleKey = createHash("sha256")
      .update(JSON.stringify(style))
      .digest("hex")
      .slice(0, 16);
    const outputPath = join(cacheDir, `${id}-${styleKey}.png`);
    if (!existsSync(outputPath) || !findWorldFile(outputPath)) {
      await renderRasterVisualization(qgisRuntime, layer.rasterPath, outputPath, style);
    }
    layer.displayPath = outputPath;
    layer.coordinates = readRasterCoordinates(outputPath);
    layer.sizeBytes = statSync(outputPath).size;
    layer.dataUrl = `/api/map/layers/${id}/data?v=${styleKey}`;
    layer.opacity = style.opacity;
    layer.style = style as unknown as Record<string, unknown>;
    return toPublic(layer);
  }

  remove(sessionId: string, id: string): boolean {
    const layer = this.layers.get(id);
    if (!layer || layer.sessionId !== sessionId) return false;
    return this.layers.delete(id);
  }

  removeSession(sessionId: string): void {
    for (const [id, layer] of this.layers) if (layer.sessionId === sessionId) this.layers.delete(id);
  }

  private require(sessionId: string, id: string): InternalPreparedLayer {
    const layer = this.layers.get(id);
    if (!layer || layer.sessionId !== sessionId) throw new Error(`Map layer not found: ${id}`);
    return layer;
  }
}

function findWorldFile(imagePath: string): string | undefined {
  const stem = imagePath.slice(0, -extname(imagePath).length);
  return [
    `${stem}.wld`,
    `${stem}.pgw`,
    `${imagePath}.wld`,
  ].find((candidate) => existsSync(candidate));
}

function readRasterCoordinates(imagePath: string): RasterImageCoordinates {
  const worldPath = findWorldFile(imagePath);
  if (!worldPath) throw new Error(`QGIS did not create a world file for the raster image: ${imagePath}`);
  const values = readFileSync(worldPath, "utf8")
    .trim()
    .split(/\s+/u)
    .map(Number);
  if (values.length < 6 || values.slice(0, 6).some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid raster world file: ${worldPath}`);
  }
  const [pixelX, rotationY, rotationX, pixelY, centerX, centerY] = values as [number, number, number, number, number, number];
  const { width, height } = readPngSize(imagePath);
  const corner = (column: number, row: number): [number, number] => [
    centerX + (column - 0.5) * pixelX + (row - 0.5) * rotationX,
    centerY + (column - 0.5) * rotationY + (row - 0.5) * pixelY,
  ];
  const coordinates: RasterImageCoordinates = [
    corner(0, 0),
    corner(width, 0),
    corner(width, height),
    corner(0, height),
  ];
  if (coordinates.some(([longitude, latitude]) =>
    longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90
  )) {
    throw new Error("Prepared raster coordinates fall outside EPSG:4326 bounds.");
  }
  return coordinates;
}

function readPngSize(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(0, 24);
  const signature = "89504e470d0a1a0a";
  if (header.length < 24 || header.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`QGIS raster cache is not a valid PNG file: ${path}`);
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error(`QGIS raster cache has invalid dimensions: ${path}`);
  return { width, height };
}

function assertGeoJson(path: string): void {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`File is not valid JSON: ${path}`); }
  if (!isRecord(value) || typeof value.type !== "string" || ![
    "FeatureCollection", "Feature", "GeometryCollection", "Point", "MultiPoint",
    "LineString", "MultiLineString", "Polygon", "MultiPolygon",
  ].includes(value.type)) throw new Error(`File is not valid GeoJSON: ${path}`);
}

function toPublic(layer: InternalPreparedLayer): PreparedMapLayer {
  const { displayPath: _displayPath, rasterPath: _rasterPath, ...value } = layer;
  return structuredClone(value);
}

type NormalizedRasterVisualization = Required<Pick<
  RasterVisualizationInput,
  "mode" | "band" | "bands" | "palette" | "zFactor" | "scale" | "azimuth" | "altitude" | "multidirectional" | "opacity" | "title"
>> & Pick<RasterVisualizationInput, "minimum" | "maximum">;

function normalizeRasterVisualization(input: RasterVisualizationInput): NormalizedRasterVisualization {
  const modes = new Set(["grayscale", "rgb", "color_relief", "hillshade"]);
  if (!modes.has(input.mode)) throw new Error(`Unsupported raster visualization mode: ${input.mode}`);
  const positiveInteger = (value: number | undefined, fallback: number, name: string): number => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer.`);
    return result;
  };
  const finite = (value: number | undefined, fallback: number, name: string, minimum?: number, maximum?: number): number => {
    const result = value ?? fallback;
    if (!Number.isFinite(result) || (minimum !== undefined && result < minimum) || (maximum !== undefined && result > maximum)) {
      throw new Error(`${name} is outside its allowed range.`);
    }
    return result;
  };
  const palette = (input.palette?.length ? input.palette : ["#313695", "#74add1", "#ffffbf", "#f46d43", "#a50026"])
    .map(normalizeHexColor);
  if (palette.length < 2 || palette.length > 12) throw new Error("Raster palette must contain 2 to 12 colors.");
  if (input.minimum !== undefined && !Number.isFinite(input.minimum)) throw new Error("minimum must be finite.");
  if (input.maximum !== undefined && !Number.isFinite(input.maximum)) throw new Error("maximum must be finite.");
  if (input.minimum !== undefined && input.maximum !== undefined && input.minimum >= input.maximum) {
    throw new Error("minimum must be less than maximum.");
  }
  return {
    mode: input.mode,
    band: positiveInteger(input.band, 1, "band"),
    bands: {
      red: positiveInteger(input.bands?.red, 1, "bands.red"),
      green: positiveInteger(input.bands?.green, 2, "bands.green"),
      blue: positiveInteger(input.bands?.blue, 3, "bands.blue"),
    },
    palette,
    ...(input.minimum !== undefined ? { minimum: input.minimum } : {}),
    ...(input.maximum !== undefined ? { maximum: input.maximum } : {}),
    zFactor: finite(input.zFactor, 1, "zFactor", 0.000001),
    scale: finite(input.scale, 111_120, "scale", 0.000001),
    azimuth: finite(input.azimuth, 315, "azimuth", 0, 360),
    altitude: finite(input.altitude, 45, "altitude", 0, 90),
    multidirectional: input.multidirectional ?? false,
    opacity: finite(input.opacity, 1, "opacity", 0, 1),
    title: input.title?.trim().slice(0, 100) || rasterModeTitle(input.mode),
  };
}

async function renderRasterVisualization(
  runtime: QgisRuntimeInfo,
  rasterPath: string,
  outputPath: string,
  style: NormalizedRasterVisualization,
): Promise<void> {
  if (style.mode === "grayscale" || style.mode === "rgb") {
    const bands = style.mode === "rgb"
      ? `-b ${style.bands.red} -b ${style.bands.green} -b ${style.bands.blue}`
      : `-b ${style.band}`;
    const scale = style.minimum !== undefined && style.maximum !== undefined
      ? `-scale ${style.minimum} ${style.maximum} 0 255`
      : "-scale";
    await runRasterAlgorithm(runtime, "gdal:translate", {
      INPUT: rasterPath,
      DATA_TYPE: 1,
      EXTRA: `${bands} ${scale} -co WORLDFILE=YES`,
      OUTPUT: outputPath,
    }, outputPath);
    return;
  }

  const intermediatePath = outputPath.replace(/\.png$/iu, ".tif");
  if (style.mode === "hillshade") {
    await runRasterAlgorithm(runtime, "gdal:hillshade", {
      INPUT: rasterPath,
      BAND: style.band,
      Z_FACTOR: style.zFactor,
      SCALE: style.scale,
      AZIMUTH: style.azimuth,
      ALTITUDE: style.altitude,
      MULTIDIRECTIONAL: style.multidirectional,
      COMPUTE_EDGES: true,
      OUTPUT: intermediatePath,
    }, intermediatePath);
  } else {
    const range = await resolveRasterRange(runtime, rasterPath, style);
    const colorTablePath = outputPath.replace(/\.png$/iu, ".colors.txt");
    writeFileSync(colorTablePath, buildColorTable(range.minimum, range.maximum, style.palette), "utf8");
    await runRasterAlgorithm(runtime, "gdal:colorrelief", {
      INPUT: rasterPath,
      BAND: style.band,
      COLOR_TABLE: colorTablePath,
      MATCH_MODE: 2,
      COMPUTE_EDGES: true,
      OUTPUT: intermediatePath,
    }, intermediatePath);
  }
  await runRasterAlgorithm(runtime, "gdal:translate", {
    INPUT: intermediatePath,
    DATA_TYPE: 1,
    EXTRA: "-co WORLDFILE=YES",
    OUTPUT: outputPath,
  }, outputPath);
}

async function resolveRasterRange(
  runtime: QgisRuntimeInfo,
  rasterPath: string,
  style: NormalizedRasterVisualization,
): Promise<{ minimum: number; maximum: number }> {
  if (style.minimum !== undefined && style.maximum !== undefined) {
    return { minimum: style.minimum, maximum: style.maximum };
  }
  const result = await executeQgisAlgorithm(runtime, "native:rasterlayerstatistics", {
    INPUT: rasterPath,
    BAND: style.band,
  });
  if (!result.ok) throw new Error(`QGIS failed to inspect raster values: ${result.stderrTail || result.stdoutTail}`);
  const minimum = style.minimum ?? readNumericQgisOutput(result.stdoutTail, "MIN");
  const maximum = style.maximum ?? readNumericQgisOutput(result.stdoutTail, "MAX");
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum) {
    throw new Error("Unable to determine a valid raster value range for color relief.");
  }
  return { minimum, maximum };
}

async function runRasterAlgorithm(
  runtime: QgisRuntimeInfo,
  algorithm: string,
  parameters: Record<string, string | number | boolean>,
  expectedPath: string,
): Promise<void> {
  const result = await executeQgisAlgorithm(runtime, algorithm, parameters);
  if (!result.ok || !existsSync(expectedPath)) {
    throw new Error(`QGIS failed to render raster visualization (${algorithm}): ${result.stderrTail || result.stdoutTail}`);
  }
}

function readNumericQgisOutput(output: string, key: string): number {
  const match = new RegExp(`(?:Result:\\s*)?${key}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, "iu").exec(output);
  return match ? Number(match[1]) : Number.NaN;
}

function buildColorTable(minimum: number, maximum: number, palette: string[]): string {
  return palette.map((color, index) => {
    const value = minimum + (maximum - minimum) * index / (palette.length - 1);
    const [red, green, blue] = hexToRgb(color);
    return `${value} ${red} ${green} ${blue} 255`;
  }).join("\n") + "\n";
}

function normalizeHexColor(value: string): string {
  const color = value.trim();
  if (!/^#[0-9a-f]{6}$/iu.test(color)) throw new Error(`Invalid raster palette color: ${value}`);
  return color.toLowerCase();
}

function hexToRgb(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function rasterModeTitle(mode: RasterVisualizationInput["mode"]): string {
  return ({
    grayscale: "Grayscale raster",
    rgb: "RGB composite",
    color_relief: "Raster color relief",
    hillshade: "Hillshade",
  })[mode];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
