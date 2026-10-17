import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentObservabilityService } from "../dist/observability/index.js";

const root = mkdtempSync(join(tmpdir(), "citybrain-observability-smoke-"));
try {
  const logDir = join(root, ".internal", "logs");
  mkdirSync(logDir, { recursive: true });
  const writeJsonl = (name, events) => writeFileSync(
    join(logDir, name),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  writeJsonl("tool-execution.jsonl", [
    { schemaVersion: 1, timestamp: "2026-01-01T00:00:00.000Z", phase: "state", executionId: "state-1", runId: "run-1", turn: 0, state: "planning", previousState: "idle" },
    { schemaVersion: 1, timestamp: "2026-01-01T00:00:01.000Z", phase: "finish", executionId: "tool-1", runId: "run-1", turn: 0, tool: "read", ok: true, durationMs: 240 },
    { schemaVersion: 1, timestamp: "2026-01-01T00:00:02.000Z", phase: "artifact", executionId: "tool-1", runId: "run-1", tool: "read", status: "ready", artifactPaths: ["result.geojson"] },
    { schemaVersion: 1, timestamp: "2026-01-01T00:00:03.000Z", phase: "state", executionId: "state-2", runId: "run-1", turn: 0, state: "completed", previousState: "executing" },
  ]);
  writeJsonl("context-trace.jsonl", [
    { schemaVersion: 1, timestamp: "2026-01-01T00:00:00.100Z", phase: "request", runId: "run-1", turn: 0, requestIndex: 0, provider: "smoke", model: "model", contextTokens: 100 },
    { schemaVersion: 1, timestamp: "2026-01-01T00:00:00.600Z", phase: "response", runId: "run-1", turn: 0, requestIndex: 0, provider: "smoke", model: "model", completionTokens: 20 },
  ]);
  writeJsonl("context-usage.jsonl", [
    { schemaVersion: 1, timestamp: "2026-01-01T00:00:00.600Z", stage: "after_response", runId: "run-1", requestIndex: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, totalTokens: 130 },
  ]);

  const tasks = [{
    id: "task-1", name: "background smoke", status: "running", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", resourceKeys: [], artifactPaths: [], metadata: { runId: "run-1", workspaceDir: root, detached: true },
  }];
  const service = new AgentObservabilityService(() => root, () => tasks);
  await service.recordTaskEvent({ type: "started", task: tasks[0] });
  const report = service.getReport();

  if (report.summary.runs !== 1 || report.summary.modelRequests !== 1) throw new Error("Run/model aggregation failed.");
  if (report.summary.toolCalls !== 1 || report.summary.toolSuccessRate !== 100) throw new Error("Tool aggregation failed.");
  if (report.summary.totalTokens !== 130 || report.summary.cacheReadTokens !== 10) throw new Error("Token aggregation failed.");
  if (report.summary.activeTasks !== 1 || report.summary.artifacts !== 1) throw new Error("Task/artifact aggregation failed.");
  if (!report.timeline.some((event) => event.kind === "task")) throw new Error("Task timeline was not persisted.");
  console.log("Observability smoke test passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
