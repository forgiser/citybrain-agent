import { lstat, readFile } from "node:fs/promises";
import type { ChatToolDefinition } from "../models/model-chat.js";
import type { ToolCallContext } from "./tool-registry.js";
import {
  atomicWriteText,
  createContentHash,
  detectLineEnding,
  normalizeText,
} from "./file-write-utils.js";

export const writeFileToolDefinition: ChatToolDefinition = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "Create a new UTF-8 text file or completely rewrite an existing UTF-8 text file inside the workspace. " +
      "Existing files must be read first. Prefer edit_file for small changes.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or absolute path inside the workspace.",
        },
        content: {
          type: "string",
          description: "Complete UTF-8 text content to write.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};

export async function executeWriteFile(
  args: unknown,
  context?: ToolCallContext,
): Promise<string> {
  if (!isRecord(args) || typeof args.path !== "string" || !args.path.trim()) {
    throw new Error("write_file requires a non-empty path.");
  }
  if (typeof args.content !== "string") {
    throw new Error("write_file requires string content.");
  }
  const sandbox = requireSandbox(context);
  const target = sandbox.resolveWritePath(args.path);
  const existing = await readExistingText(target);

  if (existing !== null) {
    assertReadBeforeWrite(target, existing, context);
  }

  const lineEnding = existing === null ? "\n" : detectLineEnding(existing.content);
  const content = restoreRequestedLineEnding(args.content, lineEnding);
  await atomicWriteText(target, content, sandbox);
  context?.markArtifactsReady?.([target]);

  return [
    existing === null ? "Created file." : "Rewrote file.",
    `Path: ${target}`,
    `Bytes: ${Buffer.byteLength(content, "utf8")}`,
  ].join("\n");
}

function assertReadBeforeWrite(
  target: string,
  existing: ExistingText,
  context?: ToolCallContext,
): void {
  const snapshot = context?.getFileReadSnapshot?.(target);
  if (!snapshot?.fullRead) {
    throw new Error(
      "Existing file must be read completely with read_file before write_file can rewrite it.",
    );
  }
  if (
    snapshot.contentHash !== createContentHash(normalizeText(existing.content)) ||
    snapshot.size !== existing.size ||
    existing.mtimeMs > snapshot.mtimeMs
  ) {
    throw new Error(
      "File changed after it was read. Read it again before calling write_file.",
    );
  }
}

function restoreRequestedLineEnding(content: string, lineEnding: "\n" | "\r\n"): string {
  const normalized = normalizeText(content);
  return lineEnding === "\r\n" ? normalized.replace(/\n/gu, "\r\n") : normalized;
}

interface ExistingText {
  content: string;
  size: number;
  mtimeMs: number;
}

async function readExistingText(path: string): Promise<ExistingText | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    return {
      content: await readFile(path, "utf8"),
      size: info.size,
      mtimeMs: Math.floor(info.mtimeMs),
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function requireSandbox(context?: ToolCallContext) {
  if (!context?.sandbox) throw new Error("Workspace sandbox is not initialized.");
  return context.sandbox;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
