import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fromFile } from "geotiff";
import { PNG } from "pngjs";
import type { QgisRuntimeInfo } from "../../integrations/qgis/qgis-runtime.js";
import { executeQgisAlgorithm } from "../../integrations/qgis/qgis-process-client.js";
import type { SessionManager } from "../../session/session-manager.js";
import { SandboxPolicy } from "../../workspace/sandbox-policy.js";

const DIRECT_EXTENSIONS = new Set([".geojson", ".json"]);
const QGIS_VECTOR_EXTENSIONS = new Set([".shp", ".gpkg", ".kml", ".gml"]);
const QGIS_RASTER_EXTENSIONS = new Set([".tif", ".tiff", ".vrt", ".img", ".asc"]);
const MODEL_EXTENSIONS = new Set([".gltf", ".glb", ".obj"]);
const TERRAIN_TILE_SIZE = 256;
const WEB_MERCATOR_HALF_WORLD = 20_037_508.342789244;
const WEB_MERCATOR_WORLD_SIZE = WEB_MERCATOR_HALF_WORLD * 2;

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
  kind: "vector" | "raster" | "model" | "tiles3d";
  sourceCrs?: string;
  displayCrs: "EPSG:4326";
  status: "ready";
  contentType: string;
  sizeBytes: number;
  dataUrl: string;
  coordinates?: RasterImageCoordinates;
  terrain?: {
    tileUrl: string;
    encoding: "mapbox";
    tileSize: 256;
    minZoom: number;
    maxZoom: number;
    bounds: [number, number, number, number];
    exaggeration: number;
  };
  scene3d?: {
    type: "model" | "tiles3d";
    format: "gltf" | "glb" | "obj" | "3dtiles";
    url: string;
    placement?: {
      longitude: number;
      latitude: number;
      altitude: number;
      scale: number;
      rotation: [number, number, number];
    };
    offset?: { east: number; up: number; south: number };
  };
  cached: boolean;
  visible: boolean;
  opacity: number;
  order: number;
  style?: Record<string, unknown>;
}

interface InternalPreparedLayer extends PreparedMapLayer {
  displayPath: string;
  rasterPath?: string;
  terrainPath?: string;
  terrainBand?: number;
  terrainTileDir?: string;
  assetRoot?: string;
}

export interface PrepareMapLayerInput {
  path?: string;
  url?: string;
  type?: "model" | "tiles3d";
  name?: string;
  layerName?: string;
  sourceCrs?: string;
  placement?: {
    longitude: number;
    latitude: number;
    altitude?: number;
    scale?: number;
    rotation?: [number, number, number];
  };
  offset?: { east?: number; up?: number; south?: number };
}

export interface RasterVisualizationInput {
  mode: "grayscale" | "rgb" | "color_relief" | "hillshade" | "terrain";
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
  exaggeration?: number;
  opacity?: number;
  title?: string;
}

export class MapLayerService {
  private readonly layers = new Map<string, InternalPreparedLayer>();
  private readonly terrainDatasets = new Map<string, Promise<Awaited<ReturnType<typeof fromFile>>>>();

  async prepare(
    session: SessionManager,
    input: PrepareMapLayerInput,
    qgisRuntime: QgisRuntimeInfo | undefined,
  ): Promise<PreparedMapLayer> {
    if (Boolean(input.path) === Boolean(input.url)) throw new Error("Exactly one of path or url is required.");
    const remoteUrl = input.url ? normalizeHttpUrl(input.url) : undefined;
    const sourcePath = remoteUrl ?? resolve(session.getProjectDir(), input.path!);
    const policy = SandboxPolicy.fromWorkspace(session.getWorkspaceDir(), session.getProjectDir());
    if (!remoteUrl) {
      policy.assertReadable(sourcePath);
      if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
        throw new Error(`Map source file does not exist: ${sourcePath}`);
      }
    }
    const extension = extname(remoteUrl ? new URL(remoteUrl).pathname : sourcePath).toLowerCase();
    const isRaster = QGIS_RASTER_EXTENSIONS.has(extension);
    const isModel = input.type === "model" || MODEL_EXTENSIONS.has(extension);
    const isTiles3d = input.type === "tiles3d";
    if (remoteUrl && !isModel && !isTiles3d) throw new Error("Remote URLs are supported only for model or tiles3d sources.");
    if (isModel && !MODEL_EXTENSIONS.has(extension)) throw new Error("3D model source must be a .gltf, .glb, or .obj file.");
    if (isTiles3d && extension !== ".json") throw new Error("3D Tiles source must point to a tileset .json file.");
    if (!DIRECT_EXTENSIONS.has(extension) && !QGIS_VECTOR_EXTENSIONS.has(extension) && !isRaster && !isModel && !isTiles3d) {
      throw new Error(`Unsupported map format: ${extension || "unknown"}. Supported: GeoJSON, SHP, GPKG, KML, GML, GeoTIFF, VRT, IMG, ASC, glTF, GLB, OBJ, and 3D Tiles.`);
    }
    const sourceStat = remoteUrl ? undefined : statSync(sourcePath);
    const placement = isModel ? normalizeModelPlacement(input.placement) : undefined;
    const offset = isTiles3d ? normalizeTilesOffset(input.offset) : undefined;
    const cacheKey = createHash("sha256").update(JSON.stringify({
      sourcePath: sourcePath.toLowerCase(),
      size: sourceStat?.size ?? 0,
      mtimeMs: sourceStat?.mtimeMs ?? 0,
      type: input.type ?? "",
      placement,
      offset,
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
    let assetRoot: string | undefined;
    let cached = false;
    let coordinates: RasterImageCoordinates | undefined;
    if (isModel || isTiles3d) {
      assetRoot = remoteUrl ? undefined : dirname(sourcePath);
    } else if (isRaster) {
      if (!qgisRuntime) throw new Error("QGIS is required to prepare raster data for the Web map.");
      const cacheDir = join(session.getWorkspaceDir(), ".internal", "map-cache");
      mkdirSync(cacheDir, { recursive: true });
      const warpedPath = join(cacheDir, `${cacheKey}.tif`);
      rasterPath = warpedPath;
      displayPath = join(cacheDir, `${cacheKey}.png`);
      cached = true;
      if (!existsSync(warpedPath)) {
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
      }
      if (!existsSync(displayPath) || !findWorldFile(displayPath)) {
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

    const displayStat = remoteUrl ? undefined : statSync(displayPath);
    const kind = isModel ? "model" : isTiles3d ? "tiles3d" : isRaster ? "raster" : "vector";
    const dataUrl = remoteUrl ?? (isModel || isTiles3d
      ? `/api/map/layers/${id}/assets/${encodeURIComponent(basename(sourcePath))}`
      : `/api/map/layers/${id}/data`);
    const layer: InternalPreparedLayer = {
      id,
      sessionId: session.getSessionId(),
      name: input.name?.trim() || (remoteUrl ? basename(new URL(remoteUrl).pathname) : basename(sourcePath)),
      sourcePath,
      sourceFormat: extension.slice(1) || "unknown",
      kind,
      ...(input.sourceCrs?.trim() ? { sourceCrs: input.sourceCrs.trim() } : {}),
      displayCrs: "EPSG:4326",
      status: "ready",
      contentType: isRaster ? "image/png" : isModel || isTiles3d ? contentTypeForPath(sourcePath) : "application/geo+json; charset=utf-8",
      sizeBytes: displayStat?.size ?? 0,
      dataUrl,
      ...(coordinates ? { coordinates } : {}),
      cached,
      visible: true,
      opacity: 1,
      order: this.list(session.getSessionId()).length,
      displayPath,
      ...(rasterPath ? { rasterPath } : {}),
      ...(assetRoot ? { assetRoot } : {}),
      ...(isModel ? { scene3d: {
        type: "model" as const,
        format: extension.slice(1) as "gltf" | "glb" | "obj",
        url: dataUrl,
        placement: placement!,
      } } : {}),
      ...(isTiles3d ? { scene3d: {
        type: "tiles3d" as const,
        format: "3dtiles" as const,
        url: dataUrl,
        offset: offset!,
      } } : {}),
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
    return layer && layer.displayPath && !layer.scene3d
      ? { sessionId: layer.sessionId, path: layer.displayPath, contentType: layer.contentType }
      : undefined;
  }

  getAsset(id: string, requestedPath: string): { sessionId: string; path: string; contentType: string } | undefined {
    const layer = this.layers.get(id);
    if (!layer?.assetRoot) return undefined;
    const path = resolve(layer.assetRoot, decodeURIComponent(requestedPath));
    const fromRoot = relative(layer.assetRoot, path);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    return { sessionId: layer.sessionId, path, contentType: contentTypeForPath(path) };
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
    if (style.mode === "terrain") {
      const terrainDataKey = createHash("sha256")
        .update(JSON.stringify({ version: 1, mode: style.mode, band: style.band }))
        .digest("hex")
        .slice(0, 16);
      const terrainPath = join(cacheDir, `${id}-${terrainDataKey}-terrain-3857.tif`);
      if (!existsSync(terrainPath)) {
        await runRasterAlgorithm(qgisRuntime, "gdal:warpreproject", {
          INPUT: layer.rasterPath,
          TARGET_CRS: "EPSG:3857",
          RESAMPLING: 1,
          MULTITHREADING: true,
          OUTPUT: terrainPath,
        }, terrainPath);
      }
      if (layer.terrainPath && layer.terrainPath !== terrainPath) this.closeTerrainDataset(id);
      const dataset = await this.openTerrainDataset(id, terrainPath);
      const image = await dataset.getImage();
      if (style.band > image.getSamplesPerPixel()) {
        throw new Error(`DEM band ${style.band} does not exist; the raster has ${image.getSamplesPerPixel()} band(s).`);
      }
      const resolution = Math.abs(image.getResolution()[0] ?? Number.NaN);
      const maxZoom = Number.isFinite(resolution) && resolution > 0
        ? Math.max(0, Math.min(18, Math.round(Math.log2(WEB_MERCATOR_WORLD_SIZE / (resolution * TERRAIN_TILE_SIZE)))))
        : 14;
      const bounds = coordinatesToBounds(layer.coordinates);
      const terrainTileDir = join(cacheDir, `${id}-${terrainDataKey}-terrain-tiles`);
      mkdirSync(terrainTileDir, { recursive: true });
      layer.terrainPath = terrainPath;
      layer.terrainBand = style.band;
      layer.terrainTileDir = terrainTileDir;
      layer.terrain = {
        tileUrl: `/api/map/layers/${id}/terrain/{z}/{x}/{y}?v=${terrainDataKey}`,
        encoding: "mapbox",
        tileSize: TERRAIN_TILE_SIZE,
        minZoom: 0,
        maxZoom,
        bounds,
        exaggeration: style.exaggeration,
      };
      layer.style = style as unknown as Record<string, unknown>;
      return toPublic(layer);
    }
    const outputPath = join(cacheDir, `${id}-${styleKey}.png`);
    if (!existsSync(outputPath) || !findWorldFile(outputPath)) {
      await renderRasterVisualization(qgisRuntime, layer.rasterPath, outputPath, style);
    }
    layer.displayPath = outputPath;
    layer.coordinates = readRasterCoordinates(outputPath);
    layer.sizeBytes = statSync(outputPath).size;
    layer.dataUrl = `/api/map/layers/${id}/data?v=${styleKey}`;
    delete layer.terrain;
    delete layer.terrainPath;
    delete layer.terrainBand;
    delete layer.terrainTileDir;
    layer.opacity = style.opacity;
    layer.style = style as unknown as Record<string, unknown>;
    return toPublic(layer);
  }

  remove(sessionId: string, id: string): boolean {
    const layer = this.layers.get(id);
    if (!layer || layer.sessionId !== sessionId) return false;
    this.closeTerrainDataset(id);
    return this.layers.delete(id);
  }

  removeSession(sessionId: string): void {
    for (const [id, layer] of this.layers) if (layer.sessionId === sessionId) {
      this.closeTerrainDataset(id);
      this.layers.delete(id);
    }
  }

  async getTerrainTile(
    id: string,
    z: number,
    x: number,
    y: number,
  ): Promise<{ sessionId: string; data?: Buffer } | undefined> {
    const layer = this.layers.get(id);
    if (!layer?.terrain || !layer.terrainPath || layer.terrainBand === undefined || !layer.terrainTileDir) return undefined;
    if (![z, x, y].every(Number.isSafeInteger) || z < 0 || z > layer.terrain.maxZoom) return undefined;
    const dimension = 2 ** z;
    if (x < 0 || y < 0 || x >= dimension || y >= dimension) return undefined;
    const dataset = await this.openTerrainDataset(id, layer.terrainPath);
    const image = await dataset.getImage();
    const tileBounds = webMercatorTileBounds(z, x, y);
    const rasterBounds = image.getBoundingBox() as [number, number, number, number];
    const intersection = intersectBounds(tileBounds, rasterBounds);
    if (!intersection) return { sessionId: layer.sessionId };

    const cachedPath = join(layer.terrainTileDir, String(z), String(x), `${y}.png`);
    if (existsSync(cachedPath)) return { sessionId: layer.sessionId, data: readFileSync(cachedPath) };
    const [tileMinX, tileMinY, tileMaxX, tileMaxY] = tileBounds;
    const span = tileMaxX - tileMinX;
    const left = Math.max(0, Math.floor((intersection[0] - tileMinX) / span * TERRAIN_TILE_SIZE));
    const right = Math.min(TERRAIN_TILE_SIZE, Math.ceil((intersection[2] - tileMinX) / span * TERRAIN_TILE_SIZE));
    const top = Math.max(0, Math.floor((tileMaxY - intersection[3]) / span * TERRAIN_TILE_SIZE));
    const bottom = Math.min(TERRAIN_TILE_SIZE, Math.ceil((tileMaxY - intersection[1]) / span * TERRAIN_TILE_SIZE));
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const rasters = await dataset.readRasters({
      bbox: intersection,
      samples: [layer.terrainBand - 1],
      width,
      height,
      resampleMethod: "bilinear",
      interleave: true,
      fillValue: image.getGDALNoData() ?? Number.NaN,
    });
    const values = Array.isArray(rasters) ? rasters[0]! : rasters;
    const noData = image.getGDALNoData();
    const png = new PNG({ width: TERRAIN_TILE_SIZE, height: TERRAIN_TILE_SIZE });
    fillTerrainRgb(png.data, 0);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const elevation = Number(values[row * width + column]);
        const invalid = !Number.isFinite(elevation)
          || elevation < -12_000
          || elevation > 100_000
          || (noData !== null && Math.abs(elevation - noData) <= Math.max(1, Math.abs(noData)) * 1e-6);
        const value = invalid ? 0 : elevation;
        writeTerrainRgb(png.data, ((top + row) * TERRAIN_TILE_SIZE + left + column) * 4, value);
      }
    }
    const data = PNG.sync.write(png);
    mkdirSync(dirname(cachedPath), { recursive: true });
    writeFileSync(cachedPath, data);
    return { sessionId: layer.sessionId, data };
  }

  private openTerrainDataset(id: string, path: string): Promise<Awaited<ReturnType<typeof fromFile>>> {
    const current = this.terrainDatasets.get(id);
    if (current) return current;
    const dataset = fromFile(path);
    this.terrainDatasets.set(id, dataset);
    return dataset;
  }

  private closeTerrainDataset(id: string): void {
    const dataset = this.terrainDatasets.get(id);
    this.terrainDatasets.delete(id);
    if (dataset) void dataset.then(async (value) => {
      await value.close();
    }).catch(() => undefined);
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
  const {
    displayPath: _displayPath,
    rasterPath: _rasterPath,
    terrainPath: _terrainPath,
    terrainBand: _terrainBand,
    terrainTileDir: _terrainTileDir,
    assetRoot: _assetRoot,
    ...value
  } = layer;
  return structuredClone(value);
}

type NormalizedRasterVisualization = Required<Pick<
  RasterVisualizationInput,
  "mode" | "band" | "bands" | "palette" | "zFactor" | "scale" | "azimuth" | "altitude" | "multidirectional" | "exaggeration" | "opacity" | "title"
>> & Pick<RasterVisualizationInput, "minimum" | "maximum">;

function normalizeRasterVisualization(input: RasterVisualizationInput): NormalizedRasterVisualization {
  const modes = new Set(["grayscale", "rgb", "color_relief", "hillshade", "terrain"]);
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
    exaggeration: finite(input.exaggeration, 1.5, "exaggeration", 0, 20),
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
    terrain: "3D terrain",
  })[mode];
}

function coordinatesToBounds(coordinates: RasterImageCoordinates | undefined): [number, number, number, number] {
  if (!coordinates) throw new Error("DEM display bounds are unavailable.");
  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  return [
    Math.max(-180, Math.min(...longitudes)),
    Math.max(-85.05112878, Math.min(...latitudes)),
    Math.min(180, Math.max(...longitudes)),
    Math.min(85.05112878, Math.max(...latitudes)),
  ];
}

function webMercatorTileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const span = WEB_MERCATOR_WORLD_SIZE / 2 ** z;
  const minimumX = -WEB_MERCATOR_HALF_WORLD + x * span;
  const maximumY = WEB_MERCATOR_HALF_WORLD - y * span;
  return [minimumX, maximumY - span, minimumX + span, maximumY];
}

function intersectBounds(
  left: [number, number, number, number],
  right: [number, number, number, number],
): [number, number, number, number] | undefined {
  const intersection: [number, number, number, number] = [
    Math.max(left[0], right[0]),
    Math.max(left[1], right[1]),
    Math.min(left[2], right[2]),
    Math.min(left[3], right[3]),
  ];
  return intersection[0] < intersection[2] && intersection[1] < intersection[3] ? intersection : undefined;
}

function fillTerrainRgb(data: Buffer, elevation: number): void {
  for (let offset = 0; offset < data.length; offset += 4) writeTerrainRgb(data, offset, elevation);
}

function writeTerrainRgb(data: Buffer, offset: number, elevation: number): void {
  const encoded = Math.max(0, Math.min(16_777_215, Math.round((elevation + 10_000) * 10)));
  data[offset] = Math.floor(encoded / 65_536);
  data[offset + 1] = Math.floor((encoded % 65_536) / 256);
  data[offset + 2] = encoded % 256;
  data[offset + 3] = 255;
}

function normalizeHttpUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("source.url must be a valid HTTP(S) URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("source.url must use HTTP or HTTPS.");
  }
  return url.href;
}

function normalizeModelPlacement(input: PrepareMapLayerInput["placement"]): NonNullable<PrepareMapLayerInput["placement"]> & {
  altitude: number;
  scale: number;
  rotation: [number, number, number];
} {
  if (!input) throw new Error("A 3D model requires placement with longitude and latitude.");
  const finite = (value: number | undefined, fallback: number, name: string): number => {
    const result = value ?? fallback;
    if (!Number.isFinite(result)) throw new Error(`${name} must be finite.`);
    return result;
  };
  const longitude = finite(input.longitude, 0, "placement.longitude");
  const latitude = finite(input.latitude, 0, "placement.latitude");
  if (longitude < -180 || longitude > 180) throw new Error("placement.longitude must be between -180 and 180.");
  if (latitude < -85.05112878 || latitude > 85.05112878) throw new Error("placement.latitude must be within the Web Mercator latitude range.");
  const scale = finite(input.scale, 1, "placement.scale");
  if (scale <= 0 || scale > 1_000_000) throw new Error("placement.scale must be greater than 0 and no more than 1000000.");
  const rotation = input.rotation ?? [0, 0, 0];
  if (rotation.length !== 3 || rotation.some((value) => !Number.isFinite(value))) {
    throw new Error("placement.rotation must contain three finite degree values.");
  }
  return {
    longitude,
    latitude,
    altitude: finite(input.altitude, 0, "placement.altitude"),
    scale,
    rotation,
  };
}

function normalizeTilesOffset(input: PrepareMapLayerInput["offset"]): { east: number; up: number; south: number } {
  const finite = (value: number | undefined, name: string): number => {
    const result = value ?? 0;
    if (!Number.isFinite(result)) throw new Error(`${name} must be finite.`);
    return result;
  };
  return {
    east: finite(input?.east, "offset.east"),
    up: finite(input?.up, "offset.up"),
    south: finite(input?.south, "offset.south"),
  };
}

function contentTypeForPath(path: string): string {
  return ({
    ".gltf": "model/gltf+json",
    ".glb": "model/gltf-binary",
    ".obj": "text/plain; charset=utf-8",
    ".mtl": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".bin": "application/octet-stream",
    ".b3dm": "application/octet-stream",
    ".i3dm": "application/octet-stream",
    ".pnts": "application/octet-stream",
    ".cmpt": "application/octet-stream",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ktx2": "image/ktx2",
  } as Record<string, string>)[extname(path.split("?")[0]!).toLowerCase()] ?? "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
