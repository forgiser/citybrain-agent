import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager, SqliteTaskStore } from "../dist/task/index.js";
import { ToolRegistry } from "../dist/tools/core/execution/tool-registry.js";
import { WorkflowService } from "../dist/workflow/index.js";
import { buildEvalReport, evaluateRecordedRun } from "../dist/eval/index.js";

const root = mkdtempSync(join(tmpdir(), "citybrain-p0-smoke-"));
let originalStore;
let recoveredStore;
try {
  const workspace = join(root, "citybrain");
  mkdirSync(workspace, { recursive: true });
  const dbPath = join(workspace, ".internal", "tasks.sqlite");
  const store = new SqliteTaskStore(dbPath);
  originalStore = store;
  const taskManager = new TaskManager({ store });
  const first = taskManager.submit({ name: "persist", idempotencyKey: "same-command", metadata: { workspaceDir: workspace }, runner: async () => "done" });
  assert.equal((await taskManager.wait(first.id)).status, "completed");
  assert.equal(taskManager.submit({ name: "duplicate", idempotencyKey: "same-command", runner: async () => "wrong" }).id, first.id);
  const now = new Date().toISOString();
  store.save({ id: "task-interrupted", name: "interrupted", status: "running", createdAt: now, updatedAt: now, resourceKeys: [], artifactPaths: [], recoveryKey: "smoke", recoveryPayload: { value: 42 }, metadata: { workspaceDir: workspace }, leaseOwner: "99999999:dead", leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
  recoveredStore = new SqliteTaskStore(dbPath);
  const restarted = new TaskManager({ store: recoveredStore });
  assert.equal(restarted.get("task-interrupted").status, "orphaned");
  assert.equal(restarted.recover("smoke", (payload) => async () => payload.value).length, 1);
  const recovered = await restarted.wait("task-interrupted");
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.attempt, 2);
  assert.equal(recovered.result, 42);

  const registry = new ToolRegistry();
  let calls = 0;
  registry.register({ type: "function", function: { name: "run_qgis_algorithm", description: "smoke", parameters: { type: "object", properties: { algorithm: { type: "string" }, parameters: { type: "object" } }, required: ["algorithm", "parameters"] } } }, async (args) => {
    calls++;
    const input = readFileSync(args.parameters.INPUT, "utf8");
    writeFileSync(args.parameters.OUTPUT, `${input}|${args.algorithm}`);
    if (args.algorithm === "fail") throw new Error("simulated processing failure");
    return "ok";
  }, { isReadOnly: true });
  const source = join(workspace, "source.txt");
  writeFileSync(source, "one");
  const paths = [source, ...[1, 2, 3].map((index) => join(workspace, `step-${index}.txt`))];
  const workflow = new WorkflowService(() => workspace, registry);
  const definition = { id: `workflow-${randomUUID()}`, version: 1, name: "three steps", workspaceDir: workspace, createdAt: now, nodes: [1, 2, 3].map((index) => ({ id: `node-${index}`, tool: "run_qgis_algorithm", arguments: { algorithm: `step-${index}`, parameters: { INPUT: paths[index - 1], OUTPUT: paths[index] } }, dependencies: index === 1 ? [] : [`node-${index - 1}`], inputPaths: [paths[index - 1]], outputPaths: [paths[index]], cachePolicy: "by-input-fingerprint", maximumAttempts: 1 })) };
  workflow.save(definition);
  assert.equal((await workflow.execute(definition.id)).status, "completed");
  assert.equal(calls, 3);
  const cached = await workflow.execute(definition.id);
  assert.equal(calls, 3);
  assert.ok(Object.values(cached.nodes).every((node) => node.status === "cached"));
  writeFileSync(source, "two");
  assert.equal((await workflow.execute(definition.id)).status, "completed");
  assert.equal(calls, 6);
  const committed = readFileSync(paths[3], "utf8");
  workflow.updateNodeArguments(definition.id, "node-3", { algorithm: "fail", parameters: { INPUT: paths[2], OUTPUT: paths[3] } });
  await assert.rejects(workflow.execute(definition.id));
  assert.equal(readFileSync(paths[3], "utf8"), committed, "failed output must not overwrite committed output");
  const executionPath = join(workspace, ".internal", "workflows", `${definition.id}.execution.json`);
  const interrupted = JSON.parse(readFileSync(executionPath, "utf8"));
  interrupted.nodes["node-3"].status = "running";
  writeFileSync(executionPath, JSON.stringify(interrupted));
  const callsBeforeRecovery = calls;
  await assert.rejects(workflow.execute(definition.id), /will not be replayed automatically/);
  assert.equal(calls, callsBeforeRecovery, "uncertain node must not be replayed after a crash");

  const logDir = join(workspace, ".internal", "logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "tool-execution.jsonl"), [
    { phase: "start", runId: "recorded-run", tool: "run_qgis_algorithm", timestamp: now },
    { phase: "finish", runId: "recorded-run", tool: "run_qgis_algorithm", ok: true, timestamp: now },
    { phase: "finish", runId: "recorded-run", tool: "map_manage_layer", ok: true, result: JSON.stringify({ layers: [{ id: "layer-1", name: "roads.geojson" }] }), timestamp: now },
    { phase: "state", runId: "recorded-run", state: "completed", timestamp: now },
  ].map(JSON.stringify).join("\n"));
  const result = evaluateRecordedRun({ id: "fixture", name: "fixture", prompt: "demo", projectDir: root, expected: { requiredTools: ["run_qgis_algorithm"], outputFiles: [{ path: "citybrain/step-3.txt", format: "file" }], mapLayers: { minCount: 1, names: ["roads.geojson"] }, maxToolCalls: 2 } }, "recorded-run");
  assert.equal(result.passed, true);
  assert.equal(buildEvalReport([result], { model: "smoke", promptVersion: "test", codeVersion: "test" }).summary.successRate, 1);
  assert.ok(existsSync(paths[3]));
  console.log("P0 smoke test passed: SQLite recovery, 3-node DAG cache/invalidation, recorded-run eval.");
} finally {
  recoveredStore?.close();
  originalStore?.close();
  rmSync(root, { recursive: true, force: true });
}
