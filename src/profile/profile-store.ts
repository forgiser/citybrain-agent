import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type {
  DatasetProfile,
  ProfileIndexEntry,
  WorkspaceProfileIndex,
  WorkspaceProfileJob,
} from "./profile-types.js";

export const PROFILE_SCHEMA_VERSION = 1;

export function getProfilePaths(workspaceDir: string): {
  root: string;
  datasets: string;
  jobs: string;
  index: string;
  markdown: string;
  lock: string;
} {
  const workspace = resolve(workspaceDir);
  const root = join(workspace, ".internal", "profiles");
  return {
    root,
    datasets: join(root, "datasets"),
    jobs: join(root, "jobs"),
    index: join(root, "index.json"),
    markdown: join(workspace, "profile.md"),
    lock: join(root, "worker.lock"),
  };
}

export function ensureProfileDirectories(workspaceDir: string): ReturnType<typeof getProfilePaths> {
  const paths = getProfilePaths(workspaceDir);
  mkdirSync(paths.datasets, { recursive: true });
  mkdirSync(paths.jobs, { recursive: true });
  return paths;
}

export function loadProfileIndex(projectDir: string, workspaceDir: string): WorkspaceProfileIndex {
  const paths = ensureProfileDirectories(workspaceDir);
  const parsed = readJson<WorkspaceProfileIndex>(paths.index);
  if (parsed?.schemaVersion === PROFILE_SCHEMA_VERSION && Array.isArray(parsed.datasets)) {
    return parsed;
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    revision: 0,
    projectDir: resolve(projectDir),
    workspaceDir: resolve(workspaceDir),
    updatedAt: now,
    datasets: [],
  };
}

export function saveProfileIndex(index: WorkspaceProfileIndex): void {
  atomicWriteJson(getProfilePaths(index.workspaceDir).index, index);
}

export function saveDatasetProfile(workspaceDir: string, profile: DatasetProfile): string {
  const paths = ensureProfileDirectories(workspaceDir);
  const path = join(paths.datasets, `${profile.id}.json`);
  atomicWriteJson(path, profile);
  return path;
}

export function removeDatasetProfile(workspaceDir: string, entry: ProfileIndexEntry): void {
  const path = resolve(getProfilePaths(workspaceDir).root, entry.profilePath);
  if (existsSync(path) && statSync(path).isFile()) unlinkSync(path);
}

export function createProfileJob(
  input: Omit<WorkspaceProfileJob, "schemaVersion" | "id" | "status" | "createdAt" | "updatedAt">,
): { job: WorkspaceProfileJob; path: string } {
  const paths = ensureProfileDirectories(input.workspaceDir);
  const now = new Date().toISOString();
  const job: WorkspaceProfileJob = {
    schemaVersion: 1,
    id: `profile-job-${randomUUID()}`,
    status: "queued",
    ...input,
    createdAt: now,
    updatedAt: now,
  };
  const path = join(paths.jobs, `${job.id}.json`);
  atomicWriteJson(path, job);
  return { job, path };
}

export function listProfileJobs(workspaceDir: string): Array<{ path: string; job: WorkspaceProfileJob }> {
  const paths = ensureProfileDirectories(workspaceDir);
  return readdirSync(paths.jobs)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const path = join(paths.jobs, name);
      const job = readJson<WorkspaceProfileJob>(path);
      return job?.schemaVersion === 1 ? [{ path, job }] : [];
    })
    .sort((left, right) => left.job.createdAt.localeCompare(right.job.createdAt));
}

export function saveProfileJob(path: string, job: WorkspaceProfileJob): void {
  atomicWriteJson(path, job);
}

export function renderProfileMarkdown(index: WorkspaceProfileIndex): string {
  const lines = [
    "<!-- 此文件由 CityBrain 工作区数据画像后台任务自动生成，请勿手动修改。 -->",
    "---",
    "schema_version: 1",
    `profile_revision: ${index.revision}`,
    `generated_at: ${index.updatedAt}`,
    `dataset_count: ${index.datasets.length}`,
    "---",
    "",
    "# 工作区数据画像",
    "",
    `项目目录：\`${escapeInline(index.projectDir)}\``,
    "",
    "本文件是内部结构化画像的 Agent 可读投影。原始数据和 `.internal/profiles/index.json` 是状态依据。",
    "",
    "## 数据集总览",
    "",
  ];
  if (index.datasets.length === 0) {
    lines.push("- 尚未发现可画像的数据。", "");
  } else {
    lines.push("| 数据集 | 类型 | 摘要 | 状态 |", "|---|---|---|---|");
    for (const entry of index.datasets) {
      lines.push(`| \`${escapeCell(entry.relativePath)}\` | ${entry.kind} | ${escapeCell(entry.summary)} | ${entry.warnings.length ? "有警告" : "正常"} |`);
    }
    lines.push("");
  }
  for (const entry of index.datasets) {
    const profile = readJson<DatasetProfile>(resolve(getProfilePaths(index.workspaceDir).root, entry.profilePath));
    if (!profile) continue;
    lines.push(`## ${profile.name}`, "", `- 路径：\`${escapeInline(profile.relativePath)}\``, `- 类型：${profile.kind}`, `- 格式：${profile.extension || "未知"}`, `- 大小：${formatBytes(profile.fingerprint.size)}`, `- 画像时间：${profile.profiledAt}`, `- 画像方法：${profile.profiler}`, "", profile.summary, "");
    const detailLines = renderDetails(profile.details);
    if (detailLines.length > 0) lines.push("### 结构与统计", "", ...detailLines, "");
    if (profile.warnings.length > 0) lines.push("### 注意事项", "", ...profile.warnings.map((value) => `- ${value}`), "");
  }
  lines.push("## 使用说明", "", "- 需要了解工作区数据、字段、空间参考或数据规模时，使用 `read_file` 读取本文件。", "- 画像在后台增量更新；若源数据仍在写入，当前摘要可能暂时滞后。", "");
  return lines.join("\n");
}

export function saveProfileMarkdown(index: WorkspaceProfileIndex): void {
  atomicWriteText(getProfilePaths(index.workspaceDir).markdown, renderProfileMarkdown(index));
}

export function profileEntryFrom(profile: DatasetProfile, profilePath: string, workspaceDir: string): ProfileIndexEntry {
  return {
    id: profile.id,
    sourcePath: profile.sourcePath,
    relativePath: profile.relativePath,
    name: profile.name,
    kind: profile.kind,
    fingerprint: profile.fingerprint,
    profilePath: relative(getProfilePaths(workspaceDir).root, profilePath).replaceAll("\\", "/"),
    profiledAt: profile.profiledAt,
    summary: profile.summary,
    warnings: [...profile.warnings],
  };
}

function renderDetails(details: Record<string, unknown>): string[] {
  const rows = Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (rows.length === 0) return [];
  return rows.slice(0, 40).map(([key, value]) => `- ${humanize(key)}：${formatDetail(value)}`);
}

function formatDetail(value: unknown): string {
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join("；");
  if (typeof value === "object" && value !== null) return `\`${escapeInline(JSON.stringify(value))}\``;
  return String(value);
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/gu, "$1 $2").replaceAll("_", " ");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function escapeCell(value: string): string { return value.replaceAll("|", "\\|").replace(/\r?\n/gu, " "); }
function escapeInline(value: string): string { return value.replaceAll("`", "\\`"); }

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}
