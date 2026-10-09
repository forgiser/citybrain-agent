import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, parse, relative, resolve } from "node:path";
import type { SessionManager } from "../../session/session-manager.js";
import { SandboxPolicy } from "../../workspace/sandbox-policy.js";

const PREVIEW_EXTENSIONS = new Set([".txt", ".md", ".json", ".geojson", ".csv", ".html"]);
const MAP_EXTENSIONS = new Set([".geojson"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_PREVIEW_BYTES = 1_000_000;

export interface WorkspaceRoot {
  id: string;
  name: string;
  path: string;
  writable: boolean;
}

export interface DirectoryBrowseResult {
  path: string;
  parent?: string;
  roots: string[];
  directories: Array<{ name: string; path: string }>;
}

/** Directory-only browser for the local project picker; file contents are never exposed. */
export async function browseDirectories(path?: string): Promise<DirectoryBrowseResult> {
  const requestedPath = path?.trim();
  if (!requestedPath) {
    return { path: "", roots: availableFilesystemRoots(), directories: [] };
  }
  const target = resolve(requestedPath);
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error("The selected path is not a directory.");
  const entries = await readdir(target, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: resolve(target, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const parent = dirname(target);
  return {
    path: target,
    ...(parent !== target ? { parent } : {}),
    roots: availableFilesystemRoots(target),
    directories,
  };
}

function availableFilesystemRoots(currentPath?: string): string[] {
  if (process.platform !== "win32") return [currentPath ? parse(currentPath).root : "/"];
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

export function getWorkspaceRoots(session: SessionManager): WorkspaceRoot[] {
  const policy = getPolicy(session);
  return policy.readRoots.map((path, index) => ({
    id: index === 0 ? "workspace" : `read-${index}`,
    name: path === policy.projectDir
      ? "项目目录"
      : path === policy.workspaceRoot
        ? "CityBrain 工作区"
        : `只读目录 ${index}`,
    path,
    writable: policy.isWritable(path),
  }));
}

export async function listWorkspaceFiles(
  session: SessionManager,
  rootId: string,
  relativePath = "",
): Promise<Record<string, unknown>> {
  const { root, path } = resolveWorkspacePath(session, rootId, relativePath);
  const entries = await readdir(path, { withFileTypes: true });
  const items = await Promise.all(
    entries
      .filter((entry) => entry.name !== ".internal")
      .map(async (entry) => {
        const entryPath = resolve(path, entry.name);
        const info = await stat(entryPath);
        const childRelativePath = relative(root.path, entryPath).replace(/\\/gu, "/");
        const extension = extname(entry.name).toLowerCase();
        return {
          name: entry.name,
          relativePath: childRelativePath,
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? info.size : undefined,
          modifiedAt: info.mtime.toISOString(),
          previewable: entry.isFile() && PREVIEW_EXTENSIONS.has(extension),
          mappable: entry.isFile() && MAP_EXTENSIONS.has(extension),
          visualization: entry.isFile() ? visualizationForExtension(extension) : undefined,
        };
      }),
  );
  items.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return String(left.name).localeCompare(String(right.name));
  });
  return { rootId, relativePath, items };
}

function visualizationForExtension(extension: string):
  | "map"
  | "markdown"
  | "html"
  | "csv"
  | "json"
  | "text"
  | "image"
  | undefined {
  if (extension === ".geojson") return "map";
  if (extension === ".json") return "json";
  if (extension === ".md") return "markdown";
  if (extension === ".html") return "html";
  if (extension === ".csv") return "csv";
  if (extension === ".txt") return "text";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return undefined;
}

export async function readWorkspaceFile(
  session: SessionManager,
  rootId: string,
  relativePath: string,
): Promise<{ content: string; truncated: boolean }> {
  const { path } = resolveWorkspacePath(session, rootId, relativePath);
  const extension = extname(path).toLowerCase();
  if (!PREVIEW_EXTENSIONS.has(extension)) {
    throw new Error("This file type cannot be previewed.");
  }
  const info = await stat(path);
  if (!info.isFile()) throw new Error("The selected path is not a file.");
  const content = await readFile(path, "utf8");
  return {
    content: content.slice(0, MAX_PREVIEW_BYTES),
    truncated: info.size > MAX_PREVIEW_BYTES,
  };
}

export function resolveWorkspacePath(
  session: SessionManager,
  rootId: string,
  relativePath: string,
): { root: WorkspaceRoot; path: string } {
  const roots = getWorkspaceRoots(session);
  const root = roots.find((entry) => entry.id === rootId);
  if (!root) throw new Error(`Unknown workspace root: ${rootId}`);
  const policy = getPolicy(session);
  const path = resolve(root.path, relativePath || ".");
  policy.assertReadable(path);
  if (!isWithin(path, root.path)) {
    throw new Error("The requested path escapes its workspace root.");
  }
  return { root, path };
}

function getPolicy(session: SessionManager): SandboxPolicy {
  return SandboxPolicy.fromWorkspace(
    session.getWorkspaceDir(),
    session.getProjectDir(),
  );
}

function isWithin(path: string, root: string): boolean {
  const target = resolve(path).toLowerCase();
  const base = resolve(root).toLowerCase();
  return target === base || target.startsWith(`${base}\\`) || target.startsWith(`${base}/`);
}
