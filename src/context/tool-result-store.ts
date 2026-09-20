import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface StoredToolResult {
  path: string;
  originalCharacters: number;
}

const TOOL_RESULTS_DIRECTORY = join(".internal", "state", "tool-results");

/**
 * Persist the canonical tool result outside the model request. The session
 * still owns the complete transcript; this store gives the projected context
 * a stable, recoverable reference when a result is too large to inline.
 */
export async function persistToolResult(
  workspaceDir: string,
  toolCallId: string | undefined,
  toolName: string | undefined,
  content: string,
): Promise<StoredToolResult> {
  const directory = join(workspaceDir, TOOL_RESULTS_DIRECTORY);
  await mkdir(directory, { recursive: true });

  const identity = `${toolCallId ?? ""}\n${toolName ?? ""}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const safeToolName = sanitizeFileName(toolName ?? "tool");
  const path = join(directory, `${safeToolName}-${digest}.txt`);
  await writeFile(path, content, "utf8");
  return {
    path,
    originalCharacters: content.length,
  };
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return sanitized || "tool";
}
