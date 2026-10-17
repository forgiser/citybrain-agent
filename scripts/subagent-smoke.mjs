import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createSubagentRegistry, createSubagentTool, subagentToolDefinition } from "../dist/tools/delegate/index.js";
import { SessionManager } from "../dist/session/session-manager.js";

const deps = {
  modelRuntime: {},
  authStorage: {},
  getCwd: () => process.cwd(),
  getQgisRuntime: () => undefined,
};

const parameters = subagentToolDefinition.function.parameters;
assert.deepEqual(parameters.required, ["subagent_type", "prompt"]);
assert.deepEqual(parameters.properties.subagent_type.enum, ["data-explorer", "spatial-planner"]);

for (const [type, expected] of [
  ["data-explorer", ["read_file", "list_files"]],
  ["spatial-planner", ["read_file", "list_files", "list_qgis_algorithms", "describe_qgis_algorithm"]],
]) {
  const registry = createSubagentRegistry(type, deps);
  assert.deepEqual(registry.definitions().map((tool) => tool.function.name), expected);
  for (const forbidden of ["delegate", "write_file", "edit_file", "run_qgis_algorithm", "map_manage_layer", "cancel_task"]) {
    assert.equal(registry.has(forbidden), false, `${type} unexpectedly exposes ${forbidden}`);
  }
}

const delegate = createSubagentTool(deps);
await assert.rejects(delegate.handler({ prompt: "inspect" }), /subagent_type/);
await assert.rejects(delegate.handler({ subagent_type: "general-purpose", prompt: "inspect" }), /subagent_type/);
await assert.rejects(delegate.handler({ subagent_type: "data-explorer", prompt: " " }), /non-empty prompt/);

const tempRoot = mkdtempSync(join(tmpdir(), "citybrain-subagent-smoke-"));
try {
  const session = SessionManager.create(tempRoot, join(tempRoot, "sessions"));
  session.appendSubagentTrace({
    parentToolCallId: "call-1",
    subagentType: "data-explorer",
    label: "inspect data",
    status: "completed",
    steps: [{ type: "tool_started", name: "read_file", toolCallId: "child-1", argumentsText: '{"path":"profile.md"}' },
      { type: "tool_result", name: "read_file", toolCallId: "child-1", ok: true, result: "profile" }],
  });
  const restored = SessionManager.open(session.getSessionFile());
  const trace = restored.getEntries().find((entry) => entry.type === "subagent_trace");
  assert.equal(trace?.parentToolCallId, "call-1");
  assert.equal(trace?.steps.length, 2);
} finally {
  const target = realpathSync(tempRoot);
  assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`));
  rmSync(target, { recursive: true, force: true });
}
console.log("subagent smoke passed");
