import assert from "node:assert/strict";
import { resolve } from "node:path";
import { TaskManager } from "../dist/task/task-manager.js";
import { ToolRegistry } from "../dist/tools/core/execution/tool-registry.js";
import { StreamingToolExecutor } from "../dist/tools/core/execution/streaming-tool-executor.js";

const manager = new TaskManager();
const registry = new ToolRegistry();
const executor = new StreamingToolExecutor(registry, manager);
let readCount = 0;
let qgisCount = 0;

function definition(name) {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  };
}

registry.register(definition("read_artifact"), async () => {
  readCount += 1;
  return "ready";
}, {
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getReadPaths: (input) => input.path,
});
registry.register(definition("run_qgis_algorithm"), async () => {
  qgisCount += 1;
  return "ran";
}, {
  supportsBackground: true,
  backgroundAfterMs: 60_000,
  getWritePaths: (input) => input.path,
});

async function execute(name, path, turn) {
  const iterator = executor.execute([{
    id: `call-${turn}`,
    name,
    arguments: JSON.stringify({ path }),
  }], { runId: "run-1", turn, sessionId: "session-1" });
  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value[0];
  }
}

function submitOutput(path, runner) {
  return manager.submit({
    name: "run_qgis_algorithm",
    artifactPaths: [path],
    resourceKeys: ["exclusive:background-tool"],
    metadata: { kind: "tool_execution", detached: true, sessionId: "session-1" },
    runner,
  });
}

const output = resolve("pending-success.geojson");
let releaseSuccess;
const upstream = submitOutput(output, () => new Promise((resolveTask) => {
  releaseSuccess = resolveTask;
}));
const dependent = execute("read_artifact", output, 1);
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.equal(readCount, 0, "dependent reader started before artifact was ready");
const deferred = await execute("run_qgis_algorithm", resolve("alternative.geojson"), 2);
assert.equal(deferred.ok, false);
assert.match(deferred.content, /not started/);
assert.equal(qgisCount, 0, "alternative QGIS algorithm started while one was pending");
releaseSuccess({ ok: true, status: "completed", taskId: upstream.id, content: "done" });
assert.equal((await dependent).ok, true);
assert.equal(readCount, 1);
const afterCompletion = await execute("run_qgis_algorithm", resolve("alternative.geojson"), 4);
assert.equal(afterCompletion.ok, true);
assert.equal(qgisCount, 1, "QGIS algorithm did not become available after completion");

const failedOutput = resolve("pending-failed.geojson");
let rejectFailure;
submitOutput(failedOutput, () => new Promise((_, rejectTask) => {
  rejectFailure = rejectTask;
}));
const blocked = execute("read_artifact", failedOutput, 3);
await new Promise((resolveTick) => setImmediate(resolveTick));
rejectFailure(new Error("processing failed"));
const failure = await blocked;
assert.equal(failure.ok, false);
assert.match(failure.content, /upstream task/);
assert.equal(readCount, 1, "reader ran despite failed upstream processing");

console.log("background dependency smoke passed");
