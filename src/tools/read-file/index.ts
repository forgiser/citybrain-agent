import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ChatToolDefinition } from "../../models/model-chat.js";
import type { ToolCallContext } from "../core/contracts/tool-context.js";
import type { ToolSpec } from "../core/contracts/tool-spec.js";
import {
  createContentHash,
  normalizeText,
} from "../core/shared/file-write-utils.js";

const DEFAULT_FILE_LINE_LIMIT = 1_000;
const MAX_FILE_LINE_LIMIT = 10_000;
const MAX_FILE_CHARS = 20_000;

export const readFileToolDefinition: ChatToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read a UTF-8 text file. Accepts an absolute path or one relative to the current directory. Supports offset and limit for reading large files in line-based chunks. Use offset to continue when output says more lines are available.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path, or relative path resolved against the current directory.",
        },
        offset: {
          type: "number",
          description: "Optional 1-indexed line number to start reading from.",
        },
        limit: {
          type: "number",
          description: `Optional maximum number of lines to read. Defaults to ${DEFAULT_FILE_LINE_LIMIT}; maximum ${MAX_FILE_LINE_LIMIT}.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

export interface ReadFileToolDependencies {
  getCwd: () => string;
}

export function createReadFileTool(
  deps: ReadFileToolDependencies,
): ToolSpec {
  return {
    definition: readFileToolDefinition,
    handler: (args, context) =>
      executeReadFile(args, deps.getCwd(), context),
    metadata: {
      source: "builtin",
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      interruptBehavior: "cancel",
      getPath: getSinglePath,
      getReadPaths: getSinglePath,
      getActivityDescription: () => "Reading file",
      getToolUseSummary: getSinglePath,
      maxResultSizeChars: 20_000,
    },
  };
}

export async function executeReadFile(
  args: unknown,
  cwd: string = process.cwd(),
  context?: ToolCallContext,
): Promise<string> {
  if (!isRecord(args) || typeof args.path !== "string" || !args.path.trim()) {
    throw new Error("read_file requires a non-empty path.");
  }

  const offset = getPositiveInteger(args.offset, "offset") ?? 1;
  const limit =
    getPositiveInteger(args.limit, "limit") ?? DEFAULT_FILE_LINE_LIMIT;
  if (limit > MAX_FILE_LINE_LIMIT) {
    throw new Error(`read_file limit must be <= ${MAX_FILE_LINE_LIMIT}.`);
  }

  const target = context?.sandbox
    ? context.sandbox.resolveReadPath(args.path, cwd)
    : resolve(cwd, args.path);
  const artifacts = context?.artifacts;
  if (artifacts?.getPending(target)) {
    const terminalArtifact = await artifacts.waitForTerminal(
      target,
      context?.signal,
    );
    if (terminalArtifact?.status === "missing") {
      throw new Error(
        [
          "The producing task finished, but the artifact is missing.",
          `task_id: ${terminalArtifact.producerTaskId}`,
          `path: ${terminalArtifact.path}`,
          terminalArtifact.error ?? "No additional error was reported.",
        ].join("\n"),
      );
    }
    if (terminalArtifact?.status === "invalid") {
      throw new Error(
        [
          "The producing task finished, but the artifact is invalid.",
          `task_id: ${terminalArtifact.producerTaskId}`,
          `path: ${terminalArtifact.path}`,
          terminalArtifact.error ?? "No additional error was reported.",
        ].join("\n"),
      );
    }
  }
  const fileInfo = await lstat(target);
  if (!fileInfo.isFile()) {
    throw new Error(`Not a regular file: ${args.path}`);
  }

  const realTarget = await realpath(target);
  const content = await readFile(realTarget, "utf8");
  const lines = content.split(/\r?\n/);
  const startIndex = offset - 1;
  if (startIndex >= lines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total).`);
  }

  const requestedEndIndex = Math.min(startIndex + limit, lines.length);
  const selectedLines = lines.slice(startIndex, requestedEndIndex);
  const { text, lineCount, truncatedByChars } = fitLinesToCharLimit(selectedLines);
  const endLine = offset + lineCount - 1;
  const hasMore = startIndex + lineCount < lines.length;
  const notices: string[] = [];

  if (truncatedByChars) {
    notices.push(
      `Showing lines ${offset}-${endLine} of ${lines.length} (${MAX_FILE_CHARS} character CLI/context limit).`,
    );
  } else if (hasMore) {
    notices.push(`Showing lines ${offset}-${endLine} of ${lines.length}.`);
  }

  if (hasMore) {
    notices.push(`Use offset=${endLine + 1} to continue.`);
  }

  if (context?.recordFileRead && !hasMore && !truncatedByChars && offset === 1) {
    const info = await stat(realTarget);
    context.recordFileRead({
      path: realTarget,
      size: info.size,
      mtimeMs: Math.floor(info.mtimeMs),
      contentHash: createContentHash(normalizeText(content)),
      fullRead: true,
    });
  }

  return notices.length > 0 ? `${text}\n\n[${notices.join(" ")}]` : text;
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

function getPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`read_file ${name} must be a positive integer.`);
  }
  return value;
}

function fitLinesToCharLimit(lines: string[]): {
  text: string;
  lineCount: number;
  truncatedByChars: boolean;
} {
  const outputLines: string[] = [];
  let totalChars = 0;

  for (const line of lines) {
    const nextChars = totalChars + line.length + (outputLines.length > 0 ? 1 : 0);
    if (nextChars > MAX_FILE_CHARS) {
      if (outputLines.length === 0) {
        return {
          text: line.slice(0, MAX_FILE_CHARS),
          lineCount: 1,
          truncatedByChars: true,
        };
      }
      break;
    }
    outputLines.push(line);
    totalChars = nextChars;
  }

  return {
    text: outputLines.join("\n"),
    lineCount: outputLines.length,
    truncatedByChars: outputLines.length < lines.length,
  };
}
