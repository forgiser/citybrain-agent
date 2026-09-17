import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCityBrainDir } from "../auth/auth-storage.js";

/**
 * Paths for the four-layer memory stores, rooted under the CityBrain data
 * directory. This is the single "set the root once" decision from the design:
 *  - memory/        → L2 long-term facts + MEMORY.md index
 *  - skills/        → L3 self-evolving runbooks + SKILLS_index
 *  - sessions/      → existing SessionManager JSONL transcripts
 *  - <project>/ANALYSIS_TASK.md → L1 current-task progress lives with the project
 */
export function getMemoryRoot(): string {
  return join(getCityBrainDir(), "memory");
}

export function getSkillsRoot(): string {
  return join(getCityBrainDir(), "skills");
}

export function getMemoryIndexPath(): string {
  return join(getMemoryRoot(), "MEMORY.md");
}

export function getSkillsIndexPath(): string {
  return join(getSkillsRoot(), "SKILLS_index.md");
}

/** L1 progress file path — inside the given working directory (the project). */
export function getAnalysisTaskPath(cwd: string): string {
  return join(cwd, "ANALYSIS_TASK.md");
}

const INDEX_MAX_BYTES = 25_000;

function readMaybe(path: string, maxBytes = Infinity): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  if (text.length === 0) return undefined;
  if (text.length > maxBytes) {
    return `${text.slice(0, maxBytes)}\n\n[truncated at ${maxBytes} characters]`;
  }
  return text;
}

/** Read the L2 memory index if present. */
export function readMemoryIndex(): string | undefined {
  return readMaybe(getMemoryIndexPath(), INDEX_MAX_BYTES);
}

/** Read the L3 skills index if present. */
export function readSkillsIndex(): string | undefined {
  return readMaybe(getSkillsIndexPath(), INDEX_MAX_BYTES);
}

/** Read the L1 current-task progress file for a working dir, if present. */
export function readAnalysisTask(cwd: string): string | undefined {
  return readMaybe(getAnalysisTaskPath(cwd));
}

/** Write (create/refresh) the L1 current-task progress file for a working dir. */
export function writeAnalysisTask(cwd: string, content: string): string {
  const path = getAnalysisTaskPath(cwd);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return path;
}

/** Best-effort project instruction lookup: <project>/CLAUDE.md or a prompt file. */
export function readProjectInstruction(cwd: string): string | undefined {
  for (const name of ["CLAUDE.md", "PROJECT.md"]) {
    const text = readMaybe(join(cwd, name));
    if (text) return text;
  }
  return undefined;
}