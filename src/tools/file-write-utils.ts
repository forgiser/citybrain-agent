import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SandboxPolicy } from "../workspace/sandbox-policy.js";

export interface FileReadSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
  contentHash: string;
  fullRead: boolean;
}

export function normalizeText(content: string): string {
  return content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

export function restoreLineEndings(content: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\r\n" ? content.replace(/\n/gu, "\r\n") : content;
}

export function detectLineEnding(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function createContentHash(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function isReservedWorkspaceFile(path: string, sandbox: SandboxPolicy): boolean {
  const normalized = normalizePath(path);
  const workspaceRoot = normalizePath(sandbox.workspaceRoot);
  if (normalized === normalizePath(join(workspaceRoot, "agent.md"))) return true;
  if (normalized === normalizePath(join(workspaceRoot, "agents.md"))) return true;
  if (normalized === normalizePath(join(workspaceRoot, "workspace.json"))) return true;
  if (normalized === normalizePath(join(workspaceRoot, "profile.md"))) return true;
  if (isWithin(normalized, normalizePath(join(workspaceRoot, ".internal")))) return true;
  return false;
}

export function assertEditablePath(path: string, sandbox: SandboxPolicy): void {
  sandbox.assertWritable(path);
  if (isReservedWorkspaceFile(path, sandbox)) {
    throw new Error(
      "This is a Harness-managed workspace file and cannot be edited by the generic file tool.",
    );
  }
}

function normalizePath(path: string): string {
  return resolve(path).replace(/[\\/]+/gu, sep).toLowerCase();
}

function isWithin(target: string, root: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("..");
}

/**
 * Write through a same-directory temporary file and rename it into place.
 * Same-directory placement keeps the final rename on one filesystem.
 */
export async function atomicWriteText(
  path: string,
  content: string,
  sandbox: SandboxPolicy,
): Promise<void> {
  assertEditablePath(path, sandbox);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  const tempPath = `${path}.citybrain-tmp-${process.pid}-${randomUUID()}`;
  sandbox.assertWritable(tempPath);
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
