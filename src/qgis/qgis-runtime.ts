import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { delimiter, dirname, join, normalize, resolve } from "node:path";
import { getCityBrainDir } from "../auth/auth-storage.js";

const QGIS_RUNTIME_CONFIG = "qgis-runtime.json";
const COMMAND_TIMEOUT_MS = 15_000;
const WINDOWS_QGIS_COMMANDS = [
  "qgis_process-qgis-ltr.bat",
  "qgis_process-qgis.bat",
  "qgis_process.bat",
  "qgis_process.exe",
];

export interface QgisRuntimeInfo {
  executablePath: string;
  version: string;
  source: "configured" | "detected";
}

interface SavedQgisRuntime {
  executablePath: string;
}

export function getQgisRuntimeConfigPath(): string {
  return join(getCityBrainDir(), QGIS_RUNTIME_CONFIG);
}

export async function detectQgisRuntime(): Promise<QgisRuntimeInfo | undefined> {
  const configuredPath = loadConfiguredQgisPath();
  if (configuredPath) {
    const configured = await validateQgisProcess(configuredPath, "configured");
    if (configured) return configured;
  }

  for (const candidate of await findQgisCandidates()) {
    const detected = await validateQgisProcess(candidate, "detected");
    if (!detected) continue;
    saveConfiguredQgisPath(candidate);
    return detected;
  }

  return undefined;
}

export async function configureQgisRuntime(path: string): Promise<QgisRuntimeInfo> {
  const candidate = cleanPathInput(path);
  if (!candidate) throw new Error("A qgis_process executable path is required.");

  const runtime = await validateQgisProcess(candidate, "configured");
  if (!runtime) {
    throw new Error(
      `Could not run qgis_process at ${candidate}. Check that the path points to qgis_process.exe or its QGIS .bat wrapper.`,
    );
  }

  saveConfiguredQgisPath(candidate);
  return runtime;
}

export function clearConfiguredQgisRuntime(): void {
  const path = getQgisRuntimeConfigPath();
  if (existsSync(path)) writeFileSync(path, "{}\n", { encoding: "utf8" });
}

export async function findQgisCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  const addCandidate = (path: string | undefined): void => {
    const cleaned = path ? cleanPathInput(path) : "";
    if (!cleaned || !existsSync(cleaned)) return;
    if (!candidates.some((candidate) => samePath(candidate, cleaned))) {
      candidates.push(cleaned);
    }
  };

  addCandidate(process.env.CITYBRAIN_QGIS_PROCESS);
  addCandidate(process.env.QGIS_PROCESS);

  for (const directory of (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    for (const command of getCommandNames()) addCandidate(join(directory, command));
  }

  for (const directory of getCommonQgisDirectories()) {
    for (const command of getCommandNames()) addCandidate(join(directory, command));
  }

  return candidates;
}

async function validateQgisProcess(
  executablePath: string,
  source: QgisRuntimeInfo["source"],
): Promise<QgisRuntimeInfo | undefined> {
  try {
    const result = await runQgisProcess(executablePath, ["--version"]);
    if (result.exitCode !== 0) return undefined;
    const version = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => /qgis/i.test(line));
    if (!version) return undefined;
    return { executablePath, version, source };
  } catch {
    return undefined;
  }
}

function runQgisProcess(
  executablePath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const isWindowsScript = /\.(?:bat|cmd)$/iu.test(executablePath);
  const command = isWindowsScript ? process.env.ComSpec || "cmd.exe" : executablePath;
  const commandArgs = isWindowsScript
    ? ["/d", "/c", "call", executablePath, ...args]
    : args;

  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      commandArgs,
      { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code === "string" && code === "ETIMEDOUT") {
          reject(error);
          return;
        }
        resolvePromise({
          exitCode: typeof error.code === "number" ? error.code : 1,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function getCommandNames(): string[] {
  return process.platform === "win32" ? WINDOWS_QGIS_COMMANDS : ["qgis_process"];
}

function getCommonQgisDirectories(): string[] {
  if (process.platform !== "win32") return [];
  const directories = ["C:\\qgis\\bin", "C:\\OSGeo4W\\bin", "C:\\OSGeo4W64\\bin"];
  for (const root of ["C:\\Program Files", "C:\\Program Files (x86)"]) {
    if (!existsSync(root)) continue;
    try {
      for (const name of readdirSync(root)) {
        if (/^qgis(?:\s|$)/iu.test(name)) directories.push(join(root, name, "bin"));
      }
    } catch {
      // An unreadable installation directory should not prevent other locations from being checked.
    }
  }
  return directories;
}

function loadConfiguredQgisPath(): string | undefined {
  const path = getQgisRuntimeConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isSavedQgisRuntime(parsed) ? cleanPathInput(parsed.executablePath) || undefined : undefined;
  } catch {
    return undefined;
  }
}

function saveConfiguredQgisPath(executablePath: string): void {
  const path = getQgisRuntimeConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const data: SavedQgisRuntime = { executablePath: normalize(resolve(executablePath)) };
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function cleanPathInput(path: string): string {
  return path.trim().replace(/^(["'])(.*)\1$/u, "$2");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function isSavedQgisRuntime(value: unknown): value is SavedQgisRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).executablePath === "string"
  );
}
