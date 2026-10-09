
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QgisRuntimeInfo } from "./qgis-runtime.js";

const QGIS_QUERY_TIMEOUT_MS = 120_000;
export const QGIS_EXECUTE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_ALGORITHM_LIST_LIMIT = 20;

interface QgisClientProcess {
  /** Command to spawn directly (the real qgis_process.exe), when resolvable. */
  executablePath: string;
  /** Environment captured from the QGIS .bat wrapper (OSGEO4W_ROOT, PATH, ...). */
  env: NodeJS.ProcessEnv;
}

interface QgisProcessOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface QgisProgress {
  elapsedMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface QgisCommandOptions {
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: (progress: QgisProgress) => void;
}

export interface QgisAlgorithmSummary {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  group?: string;
  tags?: string[];
}

export interface QgisAlgorithmListResult {
  total: number;
  matched: number;
  algorithms: QgisAlgorithmSummary[];
  truncated: boolean;
}

export interface QgisRunResult {
  ok: boolean;
  exitCode: number;
  /** Parsed `Result: KEY = VALUE` lines reported by qgis_process. */
  results: Record<string, string>;
  /** Values from `results` that look like file paths (algorithm outputs). */
  outputPaths: string[];
  expectedOutputPaths: string[];
  missingOutputPaths: string[];
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

// Resolving the direct executable and capturing its environment launches
// qgis_process once; cache per wrapper path for the process lifetime.
const clientCache = new Map<string, QgisClientProcess | undefined>();

export async function listQgisAlgorithms(
  runtime: QgisRuntimeInfo,
  filter?: string,
  limit = DEFAULT_ALGORITHM_LIST_LIMIT,
): Promise<QgisAlgorithmListResult> {
  const output = await runQgisCommand(runtime, ["list", "--json"], QGIS_QUERY_TIMEOUT_MS);
  const parsed = parseJsonOutput(output);
  const summaries = flattenAlgorithmCatalog(parsed);

  const needle = filter?.trim().toLowerCase();
  const matched = needle
    ? summaries.filter((algorithm) => matchesAlgorithm(algorithm, needle))
    : summaries;

  return {
    total: summaries.length,
    matched: matched.length,
    algorithms: matched.slice(0, limit),
    truncated: matched.length > limit,
  };
}

export async function describeQgisAlgorithm(
  runtime: QgisRuntimeInfo,
  algorithmId: string,
): Promise<string> {
  const output = await runQgisCommand(
    runtime,
    ["help", algorithmId, "--json"],
    QGIS_QUERY_TIMEOUT_MS,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Older QGIS builds may not support --json for help; fall back to raw text.
    return truncateText(output.trim() || "(no help output)", 8_000);
  }
  return formatAlgorithmHelp(parsed, algorithmId);
}

export async function executeQgisAlgorithm(
  runtime: QgisRuntimeInfo,
  algorithmId: string,
  parameters: Record<string, string | number | boolean>,
  timeoutMs = QGIS_EXECUTE_TIMEOUT_MS,
  options: QgisCommandOptions = {},
): Promise<QgisRunResult> {
  const entries = Object.entries(parameters).map(([key, value]) => {
    const serialized = typeof value === "string" ? value.trim() : String(value);
    if (!key.trim() || !serialized) {
      throw new Error(`run_qgis_algorithm received an empty parameter key or value (${key}).`);
    }
    return `${key}=${serialized}`;
  });

  const processOutcome = await runQgisCommandOutcome(
    runtime,
    ["run", algorithmId, "--", ...entries],
    timeoutMs,
    options,
  );
  const output = processOutcome.stdout;
  const combinedOutput = [output, processOutcome.stderr].filter(Boolean).join("\n");

  const results: string[] = [];
  const resultMap: Record<string, string> = {};
  const resultPattern = /^\s*Result:\s*([^=]+?)\s*=\s*(.+?)\s*$/gimu;
  for (const match of output.matchAll(resultPattern)) {
    const key = match[1]!.trim();
    const value = match[2]!.trim();
    resultMap[key] = value;
    results.push(`${key} = ${value}`);
  }
  const outputPattern = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*(.+?)\s*$/gmu;
  for (const match of output.matchAll(outputPattern)) {
    const key = match[1]!.trim();
    const value = stripOuterQuotes(match[2]!.trim());
    if (key === "OUTPUT" || key.startsWith("OUTPUT_")) {
      resultMap[key] = value;
      results.push(`${key} = ${value}`);
    }
  }

  const expectedOutputPaths = Object.entries(parameters)
    .filter(([key, value]) => /^OUTPUT(?:_|$)/iu.test(key) && typeof value === "string")
    .map(([, value]) => value as string)
    .filter((value) => looksLikePath(value));
  const outputPaths = uniquePaths([
    ...expectedOutputPaths,
    ...Object.values(resultMap).filter((value) => looksLikePath(value)),
  ]);
  const missingOutputPaths = await findMissingPaths(outputPaths);
  const ok =
    !/error|traceback/giu.test(combinedOutput) &&
    missingOutputPaths.length === 0;
  const stdoutTail = truncateText(output.trim(), 4_000);
  const stderrTail = truncateText(processOutcome.stderr.trim(), 4_000);

  return {
    ok,
    exitCode: processOutcome.exitCode,
    results: resultMap,
    outputPaths,
    expectedOutputPaths,
    missingOutputPaths,
    durationMs: processOutcome.durationMs,
    stdoutTail: [
      results.length > 0 ? `Results:\n  ${results.join("\n  ")}` : "",
      stdoutTail,
    ]
      .filter(Boolean)
      .join("\n\n"),
    stderrTail,
  };
}

export async function runQgisCommand(
  runtime: QgisRuntimeInfo,
  args: string[],
  timeoutMs: number,
  options: QgisCommandOptions = {},
): Promise<string> {
  const outcome = await runQgisCommandOutcome(runtime, args, timeoutMs, options);
  return outcome.stdout;
}

async function runQgisCommandOutcome(
  runtime: QgisRuntimeInfo,
  args: string[],
  timeoutMs: number,
  options: QgisCommandOptions = {},
): Promise<QgisProcessOutcome> {
  const client = await resolveClientProcess(runtime);
  if (client) {
    const outcome = await spawnProcess(
      client.executablePath,
      args,
      timeoutMs,
      { ...client.env, ...options.env },
      options,
    );
    if (outcome.exitCode !== 0) {
      throw new Error(
        `qgis_process failed (exit ${outcome.exitCode}): ${truncateText(outcome.stderr || outcome.stdout, 2_000)}`,
      );
    }
    return outcome;
  }

  // Fallback: drive the .bat wrapper through cmd. Values containing spaces
  // are unreliable here (cmd %* quoting), which is why direct-exe is preferred.
  const outcome = await runThroughBat(
    runtime.executablePath,
    args,
    timeoutMs,
    options,
  );
  if (outcome.exitCode !== 0) {
    throw new Error(
      `qgis_process failed (exit ${outcome.exitCode}): ${truncateText(outcome.stderr || outcome.stdout, 2_000)}`,
    );
  }
  return outcome;
}

async function resolveClientProcess(
  runtime: QgisRuntimeInfo,
): Promise<QgisClientProcess | undefined> {
  const cached = clientCache.get(runtime.executablePath);
  if (cached !== undefined) return cached;

  const resolved = await buildClientProcess(runtime);
  clientCache.set(runtime.executablePath, resolved);
  return resolved;
}

async function buildClientProcess(
  runtime: QgisRuntimeInfo,
): Promise<QgisClientProcess | undefined> {
  const env = await captureBatEnvironment(runtime.executablePath);
  if (!env) return undefined;

  const root = env.OSGEO4W_ROOT;
  if (!root) return undefined;

  for (const candidate of buildExeCandidates(runtime.executablePath, root, env)) {
    if (existsSync(candidate)) {
      return { executablePath: candidate, env: { ...process.env, ...env } };
    }
  }
  return undefined;
}

function buildExeCandidates(
  batPath: string,
  root: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const candidates: string[] = [];

  // QGIS_PREFIX_PATH points at <root>/apps/<flavor> in OSGeo4W installs.
  const prefix = env.QGIS_PREFIX_PATH?.replace(/\//gu, "\\");
  const prefixApp = prefix?.split("\\")?.filter(Boolean)?.at(-2);
  if (prefixApp) candidates.push(join(root, "apps", prefixApp, "bin", "qgis_process.exe"));

  // The wrapper names the flavor it launches, e.g. apps\qgis-ltr\bin\qgis_process.exe.
  const fromBat = /apps[\\/]+([^\\/"']+)[\\/]+bin[\\/]+qgis_process\.exe/iu.exec(batPath)?.[1];
  if (fromBat) candidates.push(join(root, "apps", fromBat, "bin", "qgis_process.exe"));

  for (const flavor of ["qgis-ltr", "qgis"]) {
    candidates.push(join(root, "apps", flavor, "bin", "qgis_process.exe"));
  }
  return candidates;
}

/**
 * The .bat wrapper assembles the OSGeo4W environment (PATH, GDAL, PROJ, Qt
 * plugins, ...) before launching qgis_process.exe. Capture that environment by
 * running the wrapper once and dumping `set`, so later calls can spawn the exe
 * directly and keep Node's reliable Windows argument quoting for paths with
 * spaces (the bat's `%*` forwarding mangles such values).
 */
async function captureBatEnvironment(batPath: string): Promise<NodeJS.ProcessEnv | undefined> {
  // cmd.exe does not follow MSVCRT quoting, so complex /c strings get mangled
  // before the wrapper ever runs. A temporary wrapper script sidesteps that:
  // it is invoked exactly like the proven `call <bat> --version` path and
  // dumps the assembled environment on stdout.
  const dumpScript = join(tmpdir(), `citybrain-qgis-env-${process.pid}.bat`);
  try {
    await writeFile(
      dumpScript,
      [
        "@echo off",
        `call "${batPath}" --version >nul 2>&1`,
        "set",
        "",
      ].join("\r\n"),
      "utf8",
    );

    const output = await new Promise<string>((resolvePromise, reject) => {
      execFile(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/c", dumpScript],
        { timeout: QGIS_QUERY_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(error);
          else resolvePromise(String(stdout) + String(stderr));
        },
      );
    });

    const env: NodeJS.ProcessEnv = {};
    for (const line of output.split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/u.exec(line);
      if (match) env[match[1]!] = match[2] ?? "";
    }
    if (!env.OSGEO4W_ROOT) return undefined;
    return env;
  } catch {
    return undefined;
  } finally {
    await rm(dumpScript, { force: true }).catch(() => undefined);
  }
}

function spawnProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  options: QgisCommandOptions = {},
): Promise<QgisProcessOutcome> {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      windowsHide: true,
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: QgisProcessOutcome): void => {
      if (settled) return;
      settled = true;
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abort);
      resolvePromise(outcome);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    };

    const abort = (): void => {
      child.kill();
      fail(new Error("qgis_process was cancelled."));
    };

    const emitProgress = (): void => {
      options.onProgress?.({
        elapsedMs: Date.now() - startedAt,
        stdoutTail: truncateText(stdout.trim(), 2_000),
        stderrTail: truncateText(stderr.trim(), 2_000),
      });
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, String(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, String(chunk));
    });
    child.once("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (code) => {
      finish({
        exitCode: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });

    options.signal?.addEventListener("abort", abort, { once: true });
    progressTimer = setInterval(emitProgress, 1_000);
    progressTimer.unref?.();
    timeoutTimer = setTimeout(() => {
      child.kill();
      fail(new Error(`qgis_process timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    timeoutTimer.unref?.();
  });
}

function runThroughBat(
  batPath: string,
  args: string[],
  timeoutMs: number,
  options: QgisCommandOptions = {},
): Promise<QgisProcessOutcome> {
  return spawnProcess(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/c", "call", batPath, ...args],
    timeoutMs,
    { ...process.env, ...options.env },
    options,
  );
}

function flattenAlgorithmCatalog(parsed: unknown): QgisAlgorithmSummary[] {
  const providers = (parsed as { providers?: unknown } | null)?.providers;
  if (typeof providers !== "object" || providers === null) return [];

  const summaries: QgisAlgorithmSummary[] = [];
  const providerEntries = Object.entries(providers as Record<string, unknown>);
  for (const [providerId, providerValue] of providerEntries) {
    const provider = providerValue as Record<string, unknown> | null;
    const algorithms = provider?.algorithms;
    if (typeof algorithms !== "object" || algorithms === null) continue;
    const providerName = typeof provider?.long_name === "string"
      ? provider.long_name
      : typeof provider?.name === "string"
        ? provider.name
        : providerId;
    const algorithmEntries = Object.entries(algorithms as Record<string, unknown>);
    for (const [id, algorithmValue] of algorithmEntries) {
      const algorithm = algorithmValue as Record<string, unknown> | null;
      summaries.push({
        id,
        name: typeof algorithm?.name === "string" ? algorithm.name : id,
        provider: providerId,
        providerName,
        group: typeof algorithm?.group === "string" ? algorithm.group : undefined,
        tags: Array.isArray(algorithm?.tags)
          ? algorithm.tags.filter((tag): tag is string => typeof tag === "string")
          : undefined,
      });
    }
  }
  return summaries;
}

function matchesAlgorithm(algorithm: QgisAlgorithmSummary, needle: string): boolean {
  const haystack = [
    algorithm.id,
    algorithm.name,
    algorithm.group ?? "",
    ...(algorithm.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function formatAlgorithmHelp(parsed: unknown, algorithmId: string): string {
  const details = (parsed as { algorithm_details?: Record<string, unknown> } | null)
    ?.algorithm_details ?? {};
  const parameters = (parsed as { parameters?: Record<string, unknown> } | null)
    ?.parameters ?? {};
  const outputs = (parsed as { outputs?: Record<string, unknown> } | null)?.outputs ?? {};

  const lines: string[] = [];
  const name = typeof details.name === "string" ? details.name : algorithmId;
  lines.push(`${algorithmId} — ${name}`);
  if (typeof details.group === "string") lines.push(`Group: ${details.group}`);
  if (typeof details.short_description === "string") lines.push(details.short_description);

  lines.push("", "Parameters:");
  const parameterEntries = Object.entries(parameters);
  if (parameterEntries.length === 0) lines.push("  (none)");
  for (const [key, parameterValue] of parameterEntries) {
    const parameter = (parameterValue ?? {}) as Record<string, unknown>;
    const parameterType = (parameter.type ?? {}) as Record<string, unknown>;
    const typeId = typeof parameterType.id === "string" ? parameterType.id : "unknown";
    const optional = parameter.optional === true;
    const defaultValue = parameter.default_value;
    const description = typeof parameter.description === "string" ? parameter.description : "";
    const flags = [
      optional ? "optional" : "required",
      defaultValue !== null && defaultValue !== undefined
        ? `default ${JSON.stringify(defaultValue)}`
        : "",
    ].filter(Boolean).join(", ");
    lines.push(`  ${key} (${typeId}${flags ? `; ${flags}` : ""}): ${description}`);

    const acceptable = parameterType.acceptable_values;
    if (Array.isArray(acceptable) && acceptable.length > 0 && acceptable.length <= 8) {
      for (const value of acceptable) {
        if (typeof value === "string") lines.push(`    - ${value}`);
      }
    }
  }

  lines.push("", "Outputs:");
  const outputEntries = Object.entries(outputs);
  if (outputEntries.length === 0) lines.push("  (none)");
  for (const [key, outputValue] of outputEntries) {
    const output = (outputValue ?? {}) as Record<string, unknown>;
    const typeId = typeof output.type === "string" ? output.type : "unknown";
    const description = typeof output.description === "string" ? output.description : "";
    lines.push(`  ${key} (${typeId}): ${description}`);
  }

  return truncateText(lines.join("\n"), 8_000);
}

function parseJsonOutput(output: string): unknown {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("qgis_process returned no JSON output.");
  return JSON.parse(output.slice(start));
}

function looksLikePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith("/");
}

function stripOuterQuotes(value: string): string {
  return value.replace(/^["']|["']$/gu, "");
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const path of paths) {
    const cleaned = stripOuterQuotes(path.trim());
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    output.push(cleaned);
  }
  return output;
}

async function findMissingPaths(paths: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const path of paths) {
    try {
      await stat(path);
    } catch {
      missing.push(path);
    }
  }
  return missing;
}

function appendOutput(current: string, chunk: string): string {
  const combined = current + chunk;
  const maxLength = 16 * 1024 * 1024;
  return combined.length <= maxLength
    ? combined
    : combined.slice(combined.length - maxLength);
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[truncated at ${maxLength} characters]`;
}
