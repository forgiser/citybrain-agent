import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../dist/session/session-manager.js";
import { ensureWorkspace } from "../dist/workspace/workspace.js";
import {
  WorkspaceProfileScheduler,
  getProfilePaths,
  runWorkspaceProfileWorker,
} from "../dist/profile/index.js";

if (process.argv[2] === "__profile-worker") {
  await runWorkspaceProfileWorker(process.argv[3]);
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "citybrain-profile-worker-smoke-"));
try {
  const sessionsRoot = join(root, "sessions");
  const workspace = ensureWorkspace(root).workspaceDir;
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const tablePath = join(dataDir, "observations.csv");
  const secondTablePath = join(dataDir, "stations.csv");
  writeFileSync(tablePath, "id,value\n1,12\n2,15\n", "utf8");
  writeFileSync(secondTablePath, "id,name\n1,north\n2,south\n", "utf8");

  const session = SessionManager.create(root, sessionsRoot);
  const scheduler = new WorkspaceProfileScheduler(() => session);
  const job = scheduler.schedule({ paths: [tablePath], runId: "smoke-run" });
  const secondJob = scheduler.schedule({ paths: [secondTablePath], runId: "smoke-run" });
  if (!job) throw new Error("The profile job was not scheduled.");
  if (!secondJob) throw new Error("The second profile job was not scheduled.");

  const jobPaths = [job, secondJob].map((item) => join(getProfilePaths(workspace).jobs, `${item.id}.json`));
  const deadline = Date.now() + 20_000;
  let completed = [];
  while (Date.now() < deadline) {
    completed = jobPaths
      .filter(existsSync)
      .map((path) => JSON.parse(readFileSync(path, "utf8")));
    if (completed.length === jobPaths.length && completed.every((item) => ["completed", "failed"].includes(item.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (completed.length !== 2 || completed.some((item) => item.status !== "completed")) {
    throw new Error(`Detached profile worker did not complete: ${JSON.stringify(completed)}`);
  }
  const sessionFiles = existsSync(sessionsRoot)
    ? readdirSync(sessionsRoot, { recursive: true }).filter((name) => String(name).endsWith(".jsonl"))
    : [];
  if (sessionFiles.length !== 0) throw new Error(`Profile worker created a conversation: ${sessionFiles.join(", ")}`);
  const profile = readFileSync(join(workspace, "profile.md"), "utf8");
  if (!profile.includes("observations.csv") || !profile.includes("stations.csv")) {
    throw new Error("The public workspace profile was not updated.");
  }
  console.log(JSON.stringify({ ok: true, statuses: completed.map((item) => item.status), results: completed.map((item) => item.result), sessionFiles: sessionFiles.length }, null, 2));
} finally {
  if (root.startsWith(tmpdir()) && root.includes("citybrain-profile-worker-smoke-")) {
    rmSync(root, { recursive: true, force: true });
  }
}
