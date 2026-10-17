import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionManager } from "../session/session-manager.js";
import { detectQgisRuntime } from "../integrations/qgis/qgis-runtime.js";
import { executeWorkspaceProfileJob } from "./profile-service.js";
import {
  createProfileJob,
  getProfilePaths,
  listProfileJobs,
  saveProfileJob,
} from "./profile-store.js";
import type { WorkspaceProfileJob } from "./profile-types.js";

const STALE_JOB_MS = 30 * 60_000;

export class WorkspaceProfileScheduler {
  constructor(private readonly getSession: () => SessionManager) {}

  schedule(input: {
    paths?: readonly string[];
    runId?: string;
    sessionId?: string;
    projectDir?: string;
    workspaceDir?: string;
  } = {}): WorkspaceProfileJob | undefined {
    const session = this.getSession();
    if (session.isTransient() && (!input.projectDir || !input.workspaceDir)) return undefined;
    const projectDir = resolve(input.projectDir ?? session.getProjectDir());
    const workspaceDir = resolve(input.workspaceDir ?? session.getWorkspaceDir());
    const changedPaths = uniquePaths(input.paths ?? []).filter((path) => isWithin(resolve(path), projectDir));
    const { job, path } = createProfileJob({
      projectDir,
      workspaceDir,
      sessionId: input.sessionId ?? session.getSessionId(),
      ...(input.runId ? { runId: input.runId } : {}),
      changedPaths,
      reconcile: true,
    });
    spawnWorker(path);
    return job;
  }

  recover(session: SessionManager = this.getSession()): void {
    if (session.isTransient()) return;
    const jobs = listProfileJobs(session.getWorkspaceDir());
    const recoverable = jobs.find(({ job }) => job.status === "queued" || isStaleRunning(job));
    if (recoverable) spawnWorker(recoverable.path);
  }
}

export async function runWorkspaceProfileWorker(jobPath: string): Promise<void> {
  const initial = readJob(jobPath);
  if (!initial) return;
  const paths = getProfilePaths(initial.workspaceDir);
  const lock = acquireWorkerLock(paths.lock);
  if (!lock) return;
  try {
    const runtime = await detectQgisRuntime();
    while (true) {
      const next = listProfileJobs(initial.workspaceDir).find(({ job }) => job.status === "queued" || isStaleRunning(job));
      if (!next) break;
      const startedAt = new Date().toISOString();
      const running: WorkspaceProfileJob = { ...next.job, status: "running", startedAt, updatedAt: startedAt, error: undefined };
      saveProfileJob(next.path, running);
      try {
        const result = await executeWorkspaceProfileJob(running, runtime);
        const completedAt = new Date().toISOString();
        saveProfileJob(next.path, { ...running, status: "completed", result, completedAt, updatedAt: completedAt });
      } catch (error) {
        const completedAt = new Date().toISOString();
        saveProfileJob(next.path, {
          ...running,
          status: "failed",
          error: error instanceof Error ? error.stack ?? error.message : String(error),
          completedAt,
          updatedAt: completedAt,
        });
      }
    }
  } finally {
    closeSync(lock);
    if (existsSync(paths.lock)) unlinkSync(paths.lock);
    // Re-check only after releasing the lock. A job may have been queued while
    // this worker was finishing, and its newly spawned worker may have observed
    // the old lock and exited before it could take ownership.
    const pending = listProfileJobs(initial.workspaceDir).find(
      ({ job }) => job.status === "queued" || isStaleRunning(job),
    );
    if (pending) spawnWorker(pending.path);
  }
}

function spawnWorker(jobPath: string): void {
  const entry = process.argv[1];
  if (!entry) return;
  const child = spawn(process.execPath, [...process.execArgv, entry, "__profile-worker", resolve(jobPath)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function acquireWorkerLock(path: string): number | undefined {
  try {
    const handle = openSync(path, "wx");
    writeFileSync(handle, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    return handle;
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs <= STALE_JOB_MS) return undefined;
      unlinkSync(path);
      const handle = openSync(path, "wx");
      writeFileSync(handle, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      return handle;
    } catch {
      return undefined;
    }
  }
}

function readJob(path: string): WorkspaceProfileJob | undefined {
  try {
    const value = JSON.parse(readFileSync(resolve(path), "utf8")) as WorkspaceProfileJob;
    return value.schemaVersion === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isStaleRunning(job: WorkspaceProfileJob): boolean {
  return job.status === "running" && Date.now() - Date.parse(job.updatedAt) > STALE_JOB_MS;
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of paths) {
    const path = resolve(value);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(path);
  }
  return output;
}

function isWithin(path: string, root: string): boolean {
  const target = process.platform === "win32" ? path.toLowerCase() : path;
  const parent = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  return target === parent || target.startsWith(`${parent}\\`) || target.startsWith(`${parent}/`);
}
