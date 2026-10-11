import { readMemoryIndex, readProjectInstruction, readSkillsIndex } from "./context-store.js";
import {
  systemPromptSection,
  volatileSystemPromptSection,
  type SystemPromptSection,
} from "./context-section.js";
import type { ContextBuildInputs, SystemContextParts } from "./context-types.js";

/** Default semantic role when the caller doesn't supply one. */
export const DEFAULT_QB_ROLE_PROMPT =
  "You are CityBrain, an assistant for urban data analysis and city data governance. " +
  "Answer clearly and concisely.";

/**
 * Assemble the system-prompt layer from three dimensions, mirroring Claude
 * Code 2's `fetchSystemPromptParts`. Each dimension is a dict of named blocks
 * so callers can attribute token budget and build a cache-key prefix:
 *
 *  - defaultSystemPrompt: STATIC base. Session-stable, only what the model
 *    "is" — identity, mission, working discipline, tool semantics, tone.
 *  - userContext:         per-user / per-project instruction + long-term
 *    memory index (L0/L2/L3). Cheap, always-loaded, cached.
 *  - systemContext:       live working state: current analysis task (L1) —
 *    the one piece that advances as tools settle, hence volatile.
 *
 * All disk reads are best-effort: a missing memory dir / project file simply
 * yields fewer blocks, never an error.
 */
export function buildContext(
  cwd: string,
  inputs: ContextBuildInputs = {},
): SystemContextParts {
  const defaultSystemPrompt = buildStaticBlocks(inputs);
  const userContext = buildInstructionBlocks(cwd, inputs);
  const systemContext = buildStateBlocks(cwd, inputs);
  return { defaultSystemPrompt, userContext, systemContext };
}

/**
 * Build the full ordered set of system-prompt sections, mirroring Claude Code
 * 2's `computeMergedSystemPromptSections`: static base section-by-section,
 * then the dynamic registry entries (which the assembly separates with the
 * dynamic-boundary marker). This is the source of truth for the final prompt;
 * `buildContext` above is the block-dictionary view kept for token metering.
 */
export function buildSystemSections(
  cwd: string,
  inputs: ContextBuildInputs = {},
): SystemPromptSection[] {
  return [
    ...buildStaticSections(inputs),
    ...buildDynamicSections(cwd, inputs),
    ...buildVolatileSections(cwd, inputs),
  ];
}

/**
 * STATIC base — stable for the whole session, so the prompt-cache prefix stays
 * byte-identical. Each section is one facet of "what CityBrain is". Kept as a
 * list (not one string) so any facet can be dropped or overridden by name.
 */
export function buildStaticSections(inputs: ContextBuildInputs): SystemPromptSection[] {
  const role = inputs.rolePrompt ?? DEFAULT_QB_ROLE_PROMPT;
  return [
    systemPromptSection("role", () => role),
    systemPromptSection("mission", () => getMission()),
    systemPromptSection("working_discipline", () => getWorkingDiscipline()),
    systemPromptSection("tool_semantics", () => getToolSemantics()),
    systemPromptSection("tone", () => getTone()),
    systemPromptSection("output_efficiency", () => getOutputEfficiency()),
    ...(inputs.hostPrompt?.staticSections ?? []).map((section) =>
      systemPromptSection(`host:${section.id}`, () => section.content)
    ),
  ];
}

function getMission(): string {
  return [
    "You work on city-data analysis and data governance.",
    "You drive geospatial work through QGIS's qgis_process command-line interface.",
    "You turn a loosely-worded analytical goal into concrete, verifiable processing steps.",
  ].join("\n");
}

function getWorkingDiscipline(): string {
  return [
    "Work one verifiable step at a time; confirm each step's result before the next.",
    "Only use tools that actually exist; never invent a tool, file, or path.",
    "When a needed input is missing, ask the user for it instead of guessing.",
  ].join("\n");
}

// Tool semantics are conceptual & stable here; the concrete definition list is
// handed to the model at call time via the tools array.
function getToolSemantics(): string {
  return [
    "qgis list    — enumerate available QGIS processing algorithms.",
    "qgis describe — inspect one algorithm's inputs/outputs so you call it correctly.",
    "qgis run     — execute a full processing workflow, feeding earlier outputs to later steps.",
    "list_files   — list files/directories under a directory (optionally filtered by glob).",
    "read_file    — read a file by absolute path when you need its raw content.",
    "write_file   — create or completely rewrite a workspace text file; read existing files first.",
    "edit_file    — replace an exact unique string in a workspace text file; read it first.",
    "get_task_status / list_tasks — inspect background work only when the user explicitly asks for status.",
    "Background task completion is delivered automatically as a task notification. Never poll a task in a loop.",
    "cancel_task — explicitly request cancellation of one background task.",
    "Never consume artifacts from a queued, running, or cancelling background task.",
    "Concurrency-safe tools may run in parallel; steps that depend on each other run sequentially.",
  ].join("\n");
}

function getTone(): string {
  return [
    "Answer in the user's language (typically Chinese).",
    "Lead with the conclusion, then the key evidence; keep it concise.",
    "When a step fails, state the cause plainly and the correction.",
  ].join("\n");
}

function getOutputEfficiency(): string {
  return "Keep text between tool calls short. Do not restate tool outputs the CLI already shows.";
}

/**
 * DYNAMIC — registry-managed. Cached entries (project instruction, memory &
 * skills indexes) stay put. The L1 analysis_task ledger is intentionally NOT
 * wired in for now (see MEMORY_DESIGN) — kept out of the prompt entirely so
 * the agent is never led to read a file that may not exist.
 */
export function buildDynamicSections(
  cwd: string,
  inputs: ContextBuildInputs,
): SystemPromptSection[] {
  return [
    volatileSystemPromptSection("project_instruction", () =>
      formatOptional(
        "Project instruction",
        inputs.projectInstructionPath
          ? readProjectInstruction(inputs.projectInstructionPath)
          : readProjectInstruction(cwd),
      ),
      "project instructions may change during a session",
    ),
    volatileSystemPromptSection("memory_index", () =>
      formatOptional("Persistent memory index", inputs.memoryIndex ?? readMemoryIndex()),
      "persistent memory may be updated by another run",
    ),
    volatileSystemPromptSection("skills_index", () =>
      formatOptional("Reusable QGIS runbook index", inputs.skillsIndex ?? readSkillsIndex()),
      "runbooks may be updated while the CLI is running",
    ),
  ];
}

/**
 * Rebuild working state before every model request. These blocks are kept
 * separate from the static prompt so a long-running QGIS task can change the
 * live context without changing the stable identity and behavior prefix.
 */
export function buildVolatileSections(
  cwd: string,
  inputs: ContextBuildInputs,
): SystemPromptSection[] {
  return [
    ...(inputs.hostPrompt?.volatileSections ?? []).map((section) =>
      volatileSystemPromptSection(
        `host:${section.id}`,
        () => section.content,
        section.reason,
      )
    ),
    volatileSystemPromptSection(
      "analysis_task",
      () => formatOptional("Current analysis task", inputs.analysisTask),
      "the task ledger changes as work progresses",
    ),
    volatileSystemPromptSection(
      "qgis_runtime",
      () =>
        inputs.qgisRuntimeSummary
          ? `QGIS runtime: ${inputs.qgisRuntimeSummary}`
          : "QGIS runtime: not configured; QGIS processing tools may be unavailable.",
      "the configured processing runtime can change during a session",
    ),
    volatileSystemPromptSection(
      "artifact_state",
      () =>
        inputs.artifactSummary
          ? `Tracked artifacts:\n${inputs.artifactSummary}`
          : "Tracked artifacts: none.",
      "tool outputs change as processing tasks settle",
    ),
    volatileSystemPromptSection(
      "background_tasks",
      () =>
        inputs.taskSummary
          ? `Background tasks:\n${inputs.taskSummary}\nDo not consume artifacts from queued, running, or cancelling tasks.`
          : "Background tasks: none.",
      "background task state changes independently of the conversation turn",
    ),
    volatileSystemPromptSection(
      "working_directories",
      () => {
        const directories = [cwd, ...(inputs.additionalWorkingDirectories ?? [])]
          .filter((value, index, values) => value && values.indexOf(value) === index);
        return directories.length > 0
          ? `Working directories:\n${directories.map((value) => `- ${value}`).join("\n")}`
          : null;
      },
      "the active session working directory can change",
    ),
    volatileSystemPromptSection(
      "today",
      () => `Today's date: ${inputs.today ?? realToday()}`,
      "date-sensitive reasoning must use the current request date",
    ),
  ];
}

/** Identity + behavior + tone blocks. Only static facets, no live state. */
function buildStaticBlocks(
  inputs: ContextBuildInputs,
): Record<string, string> {
  return {
    role: inputs.rolePrompt ?? DEFAULT_QB_ROLE_PROMPT,
    mission: getMission(),
    working_discipline: getWorkingDiscipline(),
    tool_semantics: getToolSemantics(),
    tone: getTone(),
    output_efficiency: getOutputEfficiency(),
    ...Object.fromEntries(
      (inputs.hostPrompt?.staticSections ?? []).map((section) => [
        `host:${section.id}`,
        section.content,
      ]),
    ),
  };
}

/** Per-user / per-project instructions + memory/skills indexes. */
function buildInstructionBlocks(
  cwd: string,
  inputs: ContextBuildInputs,
): Record<string, string> {
  const blocks: Record<string, string> = {};

  const project = inputs.projectInstructionPath
    ? readProjectInstruction(inputs.projectInstructionPath)
    : readProjectInstruction(cwd);
  if (project) blocks["project_instruction"] = project;

  const memoryIndex = inputs.memoryIndex ?? readMemoryIndex();
  if (memoryIndex) {
    blocks["memory_index"] = formatIndexBlock("Persistent memory index", memoryIndex);
  }

  const skillsIndex = inputs.skillsIndex ?? readSkillsIndex();
  if (skillsIndex) {
    blocks["skills_index"] = formatIndexBlock("Reusable QGIS runbook index", skillsIndex);
  }

  return blocks;
}

/** Live working state. L1 progress file for this project, if present. */
function buildStateBlocks(
  cwd: string,
  inputs: ContextBuildInputs,
): Record<string, string> {
  const blocks: Record<string, string> = {};

  for (const section of inputs.hostPrompt?.volatileSections ?? []) {
    blocks[`host:${section.id}`] = section.content;
  }

  if (inputs.analysisTask) {
    blocks["analysis_task"] = formatIndexBlock(
      "Current analysis task",
      inputs.analysisTask,
    );
  }

  if (inputs.qgisRuntimeSummary) {
    blocks["qgis_runtime"] = `QGIS runtime: ${inputs.qgisRuntimeSummary}`;
  }

  if (inputs.artifactSummary) {
    blocks["artifact_state"] = `Tracked artifacts:\n${inputs.artifactSummary}`;
  }

  if (inputs.taskSummary) {
    blocks["background_tasks"] = `Background tasks:\n${inputs.taskSummary}`;
  }

  const directories = [cwd, ...(inputs.additionalWorkingDirectories ?? [])]
    .filter((value, index, values) => value && values.indexOf(value) === index);
  if (directories.length > 0) {
    blocks["working_directories"] = [
      "Working directories:",
      ...directories.map((value) => `- ${value}`),
    ].join("\n");
  }

  blocks["today"] = `Today's date: ${inputs.today ?? realToday()}`;
  return blocks;
}

/** Wrap a raw markdown block with a heading for the model's benefit. */
function formatIndexBlock(title: string, body: string): string {
  return `---\n## ${title}\n${body.trim()}\n---`;
}

/** Like formatIndexBlock, but returns null (empty section) when body is absent. */
function formatOptional(title: string, body: string | undefined): string | null {
  return body ? formatIndexBlock(title, body) : null;
}

function realToday(): string {
  return new Date().toISOString().slice(0, 10);
}
