import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ChatToolDefinition } from "../models/model-chat.js";
import type { SandboxPolicy } from "../workspace/sandbox-policy.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 10_000;

export const listFilesToolDefinition: ChatToolDefinition = {
  type: "function",
  function: {
    name: "list_files",
    description:
      "List files and directories under a directory. Entries are sorted alphabetically with a " +
      "'/' suffix on directories. Accepts an optional glob filter and recursion. Defaults to the " +
      "current directory when no path is given. Use together with read_file to inspect a specific " +
      "file once you have located it.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to list. Absolute, or relative to the current directory. Defaults to the current directory.",
        },
        glob: {
          type: "string",
          description: "Optional filter, e.g. '*.gpkg' (matches within one level) or '**/*.shp' (any depth).",
        },
        recursive: {
          type: "boolean",
          description: "Recurse into subdirectories. Defaults to false.",
        },
        limit: {
          type: "number",
          description: `Maximum number of entries to return. Defaults to ${DEFAULT_LIMIT}; maximum ${MAX_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
  },
};

/**
 * List a directory's entries (relative to `cwd`), optionally filtered by glob
 * and recursed into subdirectories. Output is flat and sorted so the model can
 * pair a hit with read_file in one step.
 */
export async function executeListFiles(
  args: unknown,
  cwd: string = process.cwd(),
  sandbox?: SandboxPolicy,
): Promise<string> {
  if (!isRecord(args)) {
    throw new Error("list_files expects an object of arguments.");
  }

  const pathArg = typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
  const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;
  const recursive = args.recursive === true;
  const limit = getLimit(args.limit);

  const root = sandbox
    ? sandbox.resolveReadPath(pathArg, cwd)
    : resolve(cwd, pathArg);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error(`Not a directory: ${pathArg}`);
  }

  const matcher = glob ? globToRegExp(glob) : undefined;
  const entries: string[] = [];
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;

    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `Cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dirents.sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));

    for (const dirent of dirents) {
      if (truncated) return;
      const absolute = join(dir, dirent.name);
      const display = toPosix(relative(root, absolute) || dirent.name);
      const isDir = dirent.isDirectory();

      // Include the entry unless a glob is set and it doesn't match.
      const include = !matcher || matcher.test(display);
      if (include) {
        if (entries.length >= limit) {
          truncated = true;
          return;
        }
        entries.push(`${display}${isDir ? "/" : ""}`);
      }

      // Always recurse into subdirectories — a glob must reach files nested
      // below a directory that itself doesn't match the pattern.
      if (recursive && isDir) {
        await walk(absolute);
      }
    }
  };

  await walk(root);

  if (entries.length === 0) {
    return "(empty directory)";
  }

  const notice = truncated
    ? `\n\n[${limit} entries limit reached. Use limit=${limit * 2} for more.]`
    : "";
  return `${entries.join("\n")}${notice}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("list_files limit must be a positive integer.");
  }
  return Math.min(value, MAX_LIMIT);
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

/**
 * Minimal glob-to-regex: a double-star crosses `/`, and a double-star followed
 * by a slash matches zero or more leading directories. Single-star and
 * question-mark wildcards stay within one path segment.
 */
function globToRegExp(pattern: string): RegExp {
  const special = "\\.^$+()[]{}|\\";
  let source = "";

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          source += "(?:[^/]+/)*";
          index += 1;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (special.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }

  return new RegExp(`^${source}$`);
}
