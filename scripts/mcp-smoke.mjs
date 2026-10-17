import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpService } from "../dist/mcp/mcp-service.js";
import { createMcpTools } from "../dist/mcp/mcp-tools.js";
import { ToolRegistry } from "../dist/tools/core/execution/tool-registry.js";

const root = mkdtempSync(join(tmpdir(), "citybrain-mcp-smoke-"));
const service = new McpService(join(root, "mcp-servers.json"));
try {
  const fixture = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
  await service.upsert({
    name: "echo_fixture",
    description: "Test MCP service",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    enabled: true,
  });
  assert.equal(service.list()[0]?.status, "disconnected");
  const stored = readFileSync(join(root, "mcp-servers.json"), "utf8");
  assert.match(stored, /echo_fixture/u);
  assert.equal((await service.connect("echo_fixture")).status, "connected");
  const tools = await service.listTools("echo_fixture");
  assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
  assert.equal((await service.inspectTool("echo_fixture", "echo")).inputSchema.type, "object");
  assert.equal(await service.callTool("echo_fixture", "echo", { message: "hello MCP" }), "hello MCP");
  await assert.rejects(service.callTool("echo_fixture", "echo", {}), /message/u);
  const registry = new ToolRegistry({
    permissionCoordinator: {
      evaluate: async () => ({ action: "allow", source: "user", reason: "smoke test" }),
    },
  });
  registry.registerMany(createMcpTools(service));
  assert.deepEqual(registry.definitions().map((tool) => tool.function.name), [
    "mcp_list_servers", "mcp_list_tools", "mcp_inspect_tool", "mcp_call_tool",
  ]);
  const discovery = await registry.execute("mcp_list_tools", JSON.stringify({ server: "echo_fixture" }));
  assert.equal(discovery.ok, true);
  assert.match(discovery.content, /echo/u);
  const schema = await registry.execute("mcp_inspect_tool", JSON.stringify({ server: "echo_fixture", tool: "echo" }));
  assert.equal(schema.ok, true);
  assert.match(schema.content, /message/u);
  const agentCall = await registry.execute("mcp_call_tool", JSON.stringify({
    server: "echo_fixture", tool: "echo", arguments: { message: "through registry" },
  }));
  assert.equal(agentCall.ok, true);
  assert.equal(agentCall.content, "through registry");
  const unknownCall = await registry.execute("mcp_call_tool", JSON.stringify({
    server: "echo_fixture", tool: "missing", arguments: {},
  }));
  assert.equal(unknownCall.ok, false);
  await service.setEnabled("echo_fixture", false);
  assert.equal(service.list()[0]?.status, "disabled");
  await assert.rejects(service.listTools("echo_fixture"), /disabled/u);
  await service.setEnabled("echo_fixture", true);
  assert.equal(await service.remove("echo_fixture"), true);
  assert.deepEqual(service.list(), []);
  console.log("MCP smoke passed");
} finally {
  await service.dispose();
  const target = realpathSync(root);
  assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`));
  rmSync(target, { recursive: true, force: true });
}
