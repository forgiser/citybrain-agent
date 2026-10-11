import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { QgisRuntimeInfo } from "../../integrations/qgis/qgis-runtime.js";
import { executeQgisAlgorithm } from "../../integrations/qgis/qgis-process-client.js";
import type { SessionManager } from "../../session/session-manager.js";
import { SandboxPolicy } from "../../workspace/sandbox-policy.js";

const DIRECT_EXTENSIONS = new Set([".geojson", ".json"]);
const QGIS_VECTOR_EXTENSIONS = new Set([".shp", ".gpkg", ".kml", ".gml"]);

export interface PreparedMapLayer {
  id: string;
  sessionId: string;
  name: string;
  sourcePath: string;
  sourceFormat: string;
  sourceCrs?: string;
  displayCrs: "EPSG:4326";
  status: "ready";
  contentType: "application/geo+json; charset=utf-8";
  sizeBytes: number;
  dataUrl: string;
  cached: boolean;
  visible: boolean;
  opacity: number;
  order: number;
  style?: Record<string, unknown>;
}

interface InternalPreparedLayer extends PreparedMapLayer {
  displayPath: string;
}

export interface PrepareMapLayerInput {
  path: string;
  name?: string;
  layerName?: string;
  sourceCrs?: string;
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
    if (!DIRECT_EXTENSIONS.has(extension) && !QGIS_VECTOR_EXTENSIONS.has(extension)) {
      throw new Error(`Unsupported map vector format: ${extension || "unknown"}. Supported: GeoJSON, SHP, GPKG, KML, GML.`);
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
    let cached = false;
    if (DIRECT_EXTENSIONS.has(extension)) {
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
      ...(input.sourceCrs?.trim() ? { sourceCrs: input.sourceCrs.trim() } : {}),
      displayCrs: "EPSG:4326",
      status: "ready",
      contentType: "application/geo+json; charset=utf-8",
      sizeBytes: displayStat.size,
      dataUrl: `/api/map/layers/${id}/data`,
      cached,
      visible: true,
      opacity: 1,
      order: this.list(session.getSessionId()).length,
      displayPath,
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
  const { displayPath: _displayPath, ...value } = layer;
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
