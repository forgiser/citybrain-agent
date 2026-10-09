import { lstat, readFile } from "node:fs/promises";
import type { ChatToolDefinition } from "../../models/model-chat.js";
import type { ToolCallContext } from "../core/contracts/tool-context.js";
import type { ToolSpec } from "../core/contracts/tool-spec.js";
import {
  atomicWriteText,
  createContentHash,
  detectLineEnding,
  normalizeText,
  restoreLineEndings,
} from "../core/shared/file-write-utils.js";

export const editFileToolDefinition: ChatToolDefinition = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "Apply an exact string replacement to a UTF-8 text file inside the workspace. " +
      "The old_string must match; edits fail when it is ambiguous unless replace_all is true. " +
      "Read the complete file first.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or absolute path inside the workspace.",
        },
        old_string: {
          type: "string",
          description: "Exact text to replace.",
        },
        new_string: {
          type: "string",
          description: "Replacement text.",
        },
        replace_all: {
          type: "boolean",
          description: "Replace every match. Defaults to false.",
        },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
};

export function createEditFileTool(): ToolSpec {
  return {
    definition: editFileToolDefinition,
    handler: (args, context) => executeEditFile(args, context),
    metadata: {
      source: "builtin",
      isReadOnly: () => false,
      isDestructive: () => true,
      isConcurrencySafe: () => false,
      interruptBehavior: "block",
      getPath: getSinglePath,
      getWritePaths: getSinglePath,
      getActivityDescription: () => "Editing file",
      getToolUseSummary: getSinglePath,
      maxResultSizeChars: 20_000,
      requiresUserInteraction: () => true,
    },
  };
}

export async function executeEditFile(
  args: unknown,
  context?: ToolCallContext,
): Promise<string> {
  if (!isRecord(args) || typeof args.path !== "string" || !args.path.trim()) {
    throw new Error("edit_file requires a non-empty path.");
  }
  if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
    throw new Error("edit_file requires old_string and new_string.");
  }
  if (args.old_string === args.new_string) {
    throw new Error("old_string and new_string must be different.");
  }
  const replaceAll = args.replace_all === true;
  const sandbox = requireSandbox(context);
  const target = sandbox.resolveWritePath(args.path);
  const info = await lstat(target).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!info) throw new Error(`File does not exist: ${target}`);
  if (!info.isFile()) throw new Error(`Not a regular file: ${target}`);

  const raw = await readFile(target, "utf8");
  const normalized = normalizeText(raw);
  const snapshot = context?.getFileReadSnapshot?.(target);
  if (!snapshot?.fullRead) {
    throw new Error(
      "File must be read completely with read_file before edit_file can modify it.",
    );
  }
  if (
    snapshot.contentHash !== createContentHash(normalized) ||
    snapshot.size !== info.size ||
    Math.floor(info.mtimeMs) > snapshot.mtimeMs
  ) {
    throw new Error(
      "File changed after it was read. Read it again before calling edit_file.",
    );
  }

  const oldString = normalizeText(args.old_string);
  const newString = normalizeText(args.new_string);
  const matches = countMatches(normalized, oldString);
  if (matches === 0) {
    throw new Error("old_string was not found in the file.");
  }
  if (matches > 1 && !replaceAll) {
    throw new Error(
      `old_string matched ${matches} times. Add more context or set replace_all=true.`,
    );
  }

  const updated = replaceAll
    ? normalized.replaceAll(oldString, () => newString)
    : normalized.replace(oldString, () => newString);
  if (updated === normalized) throw new Error("edit_file would make no changes.");

  const content = restoreLineEndings(updated, detectLineEnding(raw));
  await atomicWriteText(target, content, sandbox);
  context?.markArtifactsReady?.([target]);

  return [
    "Edited file.",
    `Path: ${target}`,
    `Replacements: ${replaceAll ? matches : 1}`,
    `Added characters: ${newString.length}`,
    `Removed characters: ${oldString.length}`,
  ].join("\n");
}

function countMatches(content: string, search: string): number {
  if (!search) return content.length + 1;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(search, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + search.length;
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

function getSinglePath(args: unknown): string | undefined {
  if (
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args) ||
    typeof (args as { path?: unknown }).path !== "string"
  ) {
    return undefined;
  }
  const path = (args as { path: string }).path.trim();
  return path || undefined;
}
