import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { QgisRuntimeInfo } from "../integrations/qgis/qgis-runtime.js";
import { executeQgisAlgorithm } from "../integrations/qgis/qgis-process-client.js";
import {
  getProfilePaths,
  loadProfileIndex,
  profileEntryFrom,
  removeDatasetProfile,
  saveDatasetProfile,
  saveProfileIndex,
  saveProfileMarkdown,
} from "./profile-store.js";
import type { DatasetProfile, DatasetProfileKind, WorkspaceProfileJob } from "./profile-types.js";

const VECTOR_EXTENSIONS = new Set([".geojson", ".shp", ".gpkg", ".kml", ".gml"]);
const RASTER_EXTENSIONS = new Set([".tif", ".tiff", ".vrt", ".img", ".asc"]);
const TABLE_EXTENSIONS = new Set([".csv", ".tsv"]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".txt", ".html", ".htm"]);
const MODEL_EXTENSIONS = new Set([".gltf", ".glb", ".obj"]);
const MAX_SCAN_FILES = 5_000;
const RECONCILE_INTERVAL_MS = 5 * 60_000;

export interface ProfileJobResult {
  profiled: number;
  reused: number;
  removed: number;
  skipped: number;
}

export async function executeWorkspaceProfileJob(
  job: WorkspaceProfileJob,
  qgisRuntime: QgisRuntimeInfo | undefined,
): Promise<ProfileJobResult> {
  const index = loadProfileIndex(job.projectDir, job.workspaceDir);
  const byPath = new Map(index.datasets.map((entry) => [normalizePath(entry.sourcePath), entry]));
  const now = Date.now();
  const lastReconciled = index.lastReconciledAt ? Date.parse(index.lastReconciledAt) : 0;
  const shouldReconcile = job.reconcile && (!index.lastReconciledAt || now - lastReconciled >= RECONCILE_INTERVAL_MS);
  const candidates = new Set(job.changedPaths.map((path) => resolve(path)));
  if (shouldReconcile) {
    for (const path of scanProfileCandidates(job.projectDir, job.workspaceDir)) candidates.add(path);
  }

  let profiled = 0;
  let reused = 0;
  let removed = 0;
  let skipped = 0;
  for (const path of candidates) {
    if (!isProfileCandidate(path, job.workspaceDir)) { skipped += 1; continue; }
    const key = normalizePath(path);
    const current = byPath.get(key);
    if (!existsSync(path) || !statSync(path).isFile()) {
      if (current) {
        removeDatasetProfile(job.workspaceDir, current);
        byPath.delete(key);
        removed += 1;
      }
      continue;
    }
    const fingerprint = getDatasetFingerprint(path);
    if (current && current.fingerprint.size === fingerprint.size && current.fingerprint.mtimeMs === fingerprint.mtimeMs) {
      reused += 1;
      continue;
    }
    try {
      const profile = await profileDataset(path, job.projectDir, job.workspaceDir, qgisRuntime);
      if (!profile) { skipped += 1; continue; }
      const profilePath = saveDatasetProfile(job.workspaceDir, profile);
      byPath.set(key, profileEntryFrom(profile, profilePath, job.workspaceDir));
      profiled += 1;
    } catch (error) {
      const extension = extname(path).toLowerCase();
      const fallback = createBaseProfile(path, job.projectDir, classifyPath(path) ?? "document", `画像失败：${error instanceof Error ? error.message : String(error)}`);
      fallback.warnings.push(fallback.summary);
      const profilePath = saveDatasetProfile(job.workspaceDir, fallback);
      byPath.set(key, profileEntryFrom(fallback, profilePath, job.workspaceDir));
      profiled += 1;
      void extension;
    }
  }

  if (shouldReconcile) {
    const discovered = new Set([...candidates].map(normalizePath));
    for (const [key, entry] of [...byPath]) {
      if (discovered.has(key) || existsSync(entry.sourcePath)) continue;
      removeDatasetProfile(job.workspaceDir, entry);
      byPath.delete(key);
      removed += 1;
    }
  }

  const hasDatasetChanges = profiled > 0 || removed > 0;
  const profilePaths = getProfilePaths(job.workspaceDir);
  index.datasets = [...byPath.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (hasDatasetChanges) {
    index.revision += 1;
    index.updatedAt = new Date().toISOString();
  }
  if (shouldReconcile) {
    index.lastReconciledAt = new Date().toISOString();
    saveProfileIndex(index);
  } else if (hasDatasetChanges) {
    saveProfileIndex(index);
  }
  if (hasDatasetChanges || !existsSync(profilePaths.markdown)) saveProfileMarkdown(index);
  return { profiled, reused, removed, skipped };
}

export function formatWorkspaceProfilePrompt(projectDir: string, workspaceDir: string): string {
  const index = loadProfileIndex(projectDir, workspaceDir);
  const path = getProfilePaths(workspaceDir).markdown;
  return [
    `Workspace data profile: ${path}`,
    `Profile revision: ${index.revision}; datasets: ${index.datasets.length}; updated: ${index.updatedAt}.`,
    "The profile is generated asynchronously. Use read_file on profile.md when dataset structure, CRS, fields, scale, or suitability matters; do not assume it is newer than files still being written.",
  ].join("\n");
}

async function profileDataset(
  path: string,
  projectDir: string,
  workspaceDir: string,
  qgisRuntime: QgisRuntimeInfo | undefined,
): Promise<DatasetProfile | undefined> {
  const kind = classifyPath(path);
  if (!kind) return undefined;
  if (kind === "vector") return profileVector(path, projectDir, workspaceDir, qgisRuntime);
  if (kind === "raster") return profileRaster(path, projectDir, workspaceDir, qgisRuntime);
  if (kind === "table") return profileTable(path, projectDir);
  if (kind === "model3d" || kind === "tiles3d") return profileScene(path, projectDir, kind);
  return profileDocument(path, projectDir);
}

async function profileVector(path: string, projectDir: string, workspaceDir: string, runtime: QgisRuntimeInfo | undefined): Promise<DatasetProfile> {
  const profile = createBaseProfile(path, projectDir, "vector", "矢量数据");
  if (!runtime) {
    profile.profiler = "filesystem";
    profile.summary = "已识别为矢量数据；QGIS 未配置，暂未获取图层结构。";
    profile.warnings.push("QGIS 未配置，矢量元数据画像不完整。");
    return profile;
  }
  const output = join(getProfilePaths(workspaceDir).root, `ogr-${profile.id}.json`);
  try {
    const result = await executeQgisAlgorithm(runtime, "gdal:ogrinfojson", {
      INPUT: path,
      ALL_LAYERS: true,
      FEATURES: false,
      NO_METADATA: false,
      OUTPUT: output,
    });
    if (!result.ok || !existsSync(output)) throw new Error(result.stderrTail || result.stdoutTail || "QGIS 未生成矢量元数据");
    const metadata = JSON.parse(readFileSync(output, "utf8")) as unknown;
    const details = summarizeOgrMetadata(metadata);
    profile.profiler = "QGIS gdal:ogrinfojson";
    profile.details = details;
    profile.summary = summarizeVector(details);
    return profile;
  } finally {
    if (existsSync(output)) unlinkSync(output);
  }
}

async function profileRaster(path: string, projectDir: string, workspaceDir: string, runtime: QgisRuntimeInfo | undefined): Promise<DatasetProfile> {
  const profile = createBaseProfile(path, projectDir, "raster", "栅格数据");
  if (!runtime) {
    profile.profiler = "filesystem";
    profile.summary = "已识别为栅格数据；QGIS 未配置，暂未获取波段统计。";
    profile.warnings.push("QGIS 未配置，栅格元数据画像不完整。");
    return profile;
  }
  const output = join(getProfilePaths(workspaceDir).root, `gdal-${profile.id}.html`);
  try {
    const result = await executeQgisAlgorithm(runtime, "gdal:gdalinfo", {
      INPUT: path,
      MIN_MAX: false,
      STATS: true,
      NOGCP: false,
      NO_METADATA: false,
      OUTPUT: output,
    });
    if (!result.ok || !existsSync(output)) throw new Error(result.stderrTail || result.stdoutTail || "QGIS 未生成栅格元数据");
    const text = stripHtml(readFileSync(output, "utf8"));
    const details = summarizeGdalInfo(text);
    profile.profiler = "QGIS gdal:gdalinfo";
    profile.details = details;
    profile.summary = summarizeRaster(details);
    return profile;
  } finally {
    if (existsSync(output)) unlinkSync(output);
  }
}

async function profileTable(path: string, projectDir: string): Promise<DatasetProfile> {
  const profile = createBaseProfile(path, projectDir, "table", "表格数据");
  const delimiter = extname(path).toLowerCase() === ".tsv" ? "\t" : ",";
  const reader = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  let rows = 0;
  let header: string[] = [];
  const samples: string[][] = [];
  for await (const line of reader) {
    if (rows === 0) header = splitDelimited(line, delimiter);
    else if (samples.length < 20) samples.push(splitDelimited(line, delimiter));
    rows += 1;
    if (rows > 1_000_000) { profile.warnings.push("行数超过 100 万，画像统计已提前停止。"); break; }
  }
  const dataRows = Math.max(0, rows - 1);
  profile.profiler = "streaming table profiler";
  profile.details = { rowCount: dataRows, columnCount: header.length, columns: inferColumns(header, samples) };
  profile.summary = `${dataRows.toLocaleString()} 行、${header.length} 列的表格数据。`;
  return profile;
}

function profileDocument(path: string, projectDir: string): DatasetProfile {
  const profile = createBaseProfile(path, projectDir, "document", "文本数据");
  const text = readFileSync(path, "utf8").slice(0, 128_000);
  const lines = text.split(/\r?\n/u);
  const headings = lines.filter((line) => /^#{1,6}\s+/u.test(line)).slice(0, 20).map((line) => line.replace(/^#+\s*/u, ""));
  profile.profiler = "text metadata profiler";
  profile.details = { lineCount: lines.length, characterCount: text.length, headings };
  profile.summary = `${lines.length.toLocaleString()} 行文本${headings.length ? `，包含 ${headings.length} 个标题` : ""}。`;
  return profile;
}

function profileScene(path: string, projectDir: string, kind: "model3d" | "tiles3d"): DatasetProfile {
  const profile = createBaseProfile(path, projectDir, kind, kind === "tiles3d" ? "3D Tiles 数据" : "三维模型");
  const extension = extname(path).toLowerCase();
  if (extension === ".gltf" || kind === "tiles3d") {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (kind === "tiles3d") {
      profile.details = summarizeTileset(value);
      profile.profiler = "3D Tiles JSON profiler";
      profile.summary = `3D Tiles 数据，根几何误差 ${String(profile.details.geometricError ?? "未知")}。`;
    } else {
      profile.details = summarizeGltf(value);
      profile.profiler = "glTF structure profiler";
      profile.summary = `glTF 模型，${String(profile.details.meshCount ?? 0)} 个网格、${String(profile.details.materialCount ?? 0)} 个材质。`;
    }
  } else if (extension === ".glb") {
    const buffer = readFileSync(path).subarray(0, 20);
    profile.details = { magic: buffer.subarray(0, 4).toString("utf8"), version: buffer.readUInt32LE(4), declaredLength: buffer.readUInt32LE(8) };
    profile.profiler = "GLB header profiler";
    profile.summary = `GLB ${String(profile.details.version)} 三维模型。`;
  } else {
    const text = readFileSync(path, "utf8");
    profile.details = {
      vertices: (text.match(/^v\s+/gmu) ?? []).length,
      textureCoordinates: (text.match(/^vt\s+/gmu) ?? []).length,
      normals: (text.match(/^vn\s+/gmu) ?? []).length,
      faces: (text.match(/^f\s+/gmu) ?? []).length,
      materialLibraries: [...text.matchAll(/^mtllib\s+(.+)$/gmu)].slice(0, 20).map((match) => match[1]),
    };
    profile.profiler = "OBJ structure profiler";
    profile.summary = `OBJ 模型，${String(profile.details.vertices)} 个顶点、${String(profile.details.faces)} 个面。`;
  }
  return profile;
}

function createBaseProfile(path: string, projectDir: string, kind: DatasetProfileKind, summary: string): DatasetProfile {
  const sourcePath = resolve(path);
  const fingerprint = getDatasetFingerprint(sourcePath);
  const extension = extname(sourcePath).toLowerCase().slice(1);
  const id = `${kind}-${createHash("sha256").update(normalizePath(sourcePath)).digest("hex").slice(0, 20)}`;
  return {
    schemaVersion: 1,
    id,
    sourcePath,
    relativePath: relative(projectDir, sourcePath).replaceAll("\\", "/"),
    name: basename(sourcePath),
    extension,
    kind,
    fingerprint,
    profiledAt: new Date().toISOString(),
    profiler: "filesystem",
    summary,
    details: {},
    warnings: [],
  };
}

function scanProfileCandidates(projectDir: string, workspaceDir: string): string[] {
  const output: string[] = [];
  const pending = [resolve(projectDir)];
  const internalRoot = normalizePath(join(workspaceDir, ".internal"));
  while (pending.length > 0 && output.length < MAX_SCAN_FILES) {
    const directory = pending.pop()!;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (normalizePath(path).startsWith(`${internalRoot}${sep}`)) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && isProfileCandidate(path, workspaceDir)) output.push(path);
      if (output.length >= MAX_SCAN_FILES) break;
    }
  }
  return output;
}

function getDatasetFingerprint(path: string): { size: number; mtimeMs: number } {
  const sourcePath = resolve(path);
  if (extname(sourcePath).toLowerCase() !== ".shp") {
    const stat = statSync(sourcePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  }
  const stem = basename(sourcePath, extname(sourcePath));
  const components = [".shp", ".dbf", ".shx", ".prj", ".cpg"]
    .map((extension) => join(dirname(sourcePath), `${stem}${extension}`))
    .filter(existsSync);
  return components.reduce(
    (fingerprint, component) => {
      const stat = statSync(component);
      return {
        size: fingerprint.size + stat.size,
        mtimeMs: Math.max(fingerprint.mtimeMs, stat.mtimeMs),
      };
    },
    { size: 0, mtimeMs: 0 },
  );
}

function isProfileCandidate(path: string, workspaceDir: string): boolean {
  const normalized = normalizePath(path);
  const paths = getProfilePaths(workspaceDir);
  const managedWorkspaceFiles = new Set([
    normalizePath(paths.markdown),
    normalizePath(join(workspaceDir, "AGENTS.md")),
    normalizePath(join(workspaceDir, "AGENT.md")),
    normalizePath(join(workspaceDir, "workspace.json")),
  ]);
  if (managedWorkspaceFiles.has(normalized) || normalized.startsWith(`${normalizePath(paths.root)}${sep}`)) return false;
  return classifyPath(path) !== undefined;
}

function classifyPath(path: string): DatasetProfileKind | undefined {
  const extension = extname(path).toLowerCase();
  if (VECTOR_EXTENSIONS.has(extension)) return "vector";
  if (RASTER_EXTENSIONS.has(extension)) return "raster";
  if (TABLE_EXTENSIONS.has(extension)) return "table";
  if (MODEL_EXTENSIONS.has(extension)) return "model3d";
  if (extension === ".json" && basename(path).toLowerCase() === "tileset.json") return "tiles3d";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  return undefined;
}

function summarizeOgrMetadata(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  const layers = Array.isArray(record.layers) ? record.layers.filter(isRecord) : [];
  return {
    driver: readNestedString(record, ["driverShortName"]) ?? readNestedString(record, ["driver", "shortName"]),
    layerCount: layers.length,
    layers: layers.slice(0, 50).map((layer) => ({
      name: layer.name,
      featureCount: layer.featureCount,
      geometryType: Array.isArray(layer.geometryFields) && isRecord(layer.geometryFields[0]) ? layer.geometryFields[0].type : layer.geometryType,
      fieldCount: Array.isArray(layer.fields) ? layer.fields.length : undefined,
      fields: Array.isArray(layer.fields) ? layer.fields.slice(0, 50).map((field) => isRecord(field) ? { name: field.name, type: field.type, nullable: field.nullable } : field) : undefined,
      extent: layer.extent,
      coordinateSystem: isRecord(layer.coordinateSystem) ? layer.coordinateSystem.wkt ?? layer.coordinateSystem.projjson : layer.coordinateSystem,
    })),
  };
}

function summarizeVector(details: Record<string, unknown>): string {
  const layers = Array.isArray(details.layers) ? details.layers.filter(isRecord) : [];
  const features = layers.reduce((sum, layer) => sum + (typeof layer.featureCount === "number" ? layer.featureCount : 0), 0);
  return `${layers.length || 1} 个图层${features ? `、共 ${features.toLocaleString()} 个要素` : ""}的矢量数据。`;
}

function summarizeGdalInfo(text: string): Record<string, unknown> {
  const size = /Size is\s+(\d+)\s*,\s*(\d+)/iu.exec(text);
  const bands = [...text.matchAll(/Band\s+(\d+)\s+Block=/giu)].map((match) => Number(match[1]));
  const projection = /Coordinate System is:\s*([\s\S]{0,1500}?)(?:Origin =|Data axis)/iu.exec(text)?.[1]?.trim();
  const minimum = /STATISTICS_MINIMUM=([^\s<]+)/iu.exec(text)?.[1];
  const maximum = /STATISTICS_MAXIMUM=([^\s<]+)/iu.exec(text)?.[1];
  const mean = /STATISTICS_MEAN=([^\s<]+)/iu.exec(text)?.[1];
  const stdDev = /STATISTICS_STDDEV=([^\s<]+)/iu.exec(text)?.[1];
  return {
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
    bandCount: bands.length || undefined,
    minimum: toNumber(minimum),
    maximum: toNumber(maximum),
    mean: toNumber(mean),
    standardDeviation: toNumber(stdDev),
    coordinateSystem: projection?.slice(0, 800),
  };
}

function summarizeRaster(details: Record<string, unknown>): string {
  const dimensions = details.width && details.height ? `${details.width} × ${details.height}` : "未知尺寸";
  const range = details.minimum !== undefined && details.maximum !== undefined ? `，值域 ${details.minimum}～${details.maximum}` : "";
  return `${dimensions}、${String(details.bandCount ?? "未知")} 波段的栅格数据${range}。`;
}

function inferColumns(header: string[], samples: string[][]): Array<Record<string, unknown>> {
  return header.slice(0, 100).map((name, index) => {
    const values = samples.map((row) => row[index] ?? "").filter(Boolean);
    const numeric = values.length > 0 && values.every((value) => Number.isFinite(Number(value)));
    return { name, type: numeric ? "number" : "string", sampledNonEmpty: values.length };
  });
}

function splitDelimited(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"' && line[index + 1] === '"' && quoted) { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { values.push(value); value = ""; }
    else value += char;
  }
  values.push(value);
  return values;
}

function summarizeGltf(value: Record<string, unknown>): Record<string, unknown> {
  return {
    assetVersion: isRecord(value.asset) ? value.asset.version : undefined,
    sceneCount: Array.isArray(value.scenes) ? value.scenes.length : 0,
    nodeCount: Array.isArray(value.nodes) ? value.nodes.length : 0,
    meshCount: Array.isArray(value.meshes) ? value.meshes.length : 0,
    materialCount: Array.isArray(value.materials) ? value.materials.length : 0,
    textureCount: Array.isArray(value.textures) ? value.textures.length : 0,
    animationCount: Array.isArray(value.animations) ? value.animations.length : 0,
    extensionsUsed: value.extensionsUsed,
  };
}

function summarizeTileset(value: Record<string, unknown>): Record<string, unknown> {
  return {
    assetVersion: isRecord(value.asset) ? value.asset.version : undefined,
    geometricError: value.geometricError,
    rootRefine: isRecord(value.root) ? value.root.refine : undefined,
    rootBoundingVolume: isRecord(value.root) ? value.root.boundingVolume : undefined,
    rootChildren: isRecord(value.root) && Array.isArray(value.root.children) ? value.root.children.length : 0,
    extensionsUsed: value.extensionsUsed,
  };
}

function stripHtml(value: string): string { return value.replace(/<[^>]+>/gu, " ").replace(/&nbsp;/gu, " ").replace(/&quot;/gu, '"').replace(/\s+/gu, " "); }
function normalizePath(path: string): string { return resolve(path).replace(/[\\/]+/gu, sep).toLowerCase(); }
function toNumber(value: string | undefined): number | undefined { const number = value === undefined ? NaN : Number(value); return Number.isFinite(number) ? number : undefined; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function readNestedString(value: Record<string, unknown>, keys: string[]): string | undefined { let current: unknown = value; for (const key of keys) { if (!isRecord(current)) return undefined; current = current[key]; } return typeof current === "string" ? current : undefined; }
