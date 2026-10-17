import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRuntime } from "../dist/runtime/create-runtime.js";
import { createAgentHostProfile } from "../dist/host/index.js";
import { startWebApp } from "../dist/adapters/web/web-server.js";

const root = mkdtempSync(join(tmpdir(), "citybrain-mcp-web-smoke-"));
process.env.CITYBRAIN_AGENT_DIR = join(root, "user-data");
let app;
let runtime;
try {
  runtime = await createAgentRuntime({
    cwd: root,
    hostProfile: createAgentHostProfile("web"),
    resolveQgisRuntime: async () => undefined,
  });
  app = await startWebApp(runtime, {
    port: 38000 + Math.floor(Math.random() * 1000),
    openBrowser: false,
  });
  const fixture = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
  const request = async (path, method = "GET", body) => {
    const response = await fetch(`${app.address}${path}`, {
      method,
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  };
  assert.deepEqual((await request("/api/settings/mcp/servers")).servers, []);
  const crossOrigin = await fetch(`${app.address}/api/settings/mcp/servers`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: "https://example.org" },
    body: JSON.stringify({ name: "blocked", transport: "stdio", command: process.execPath }),
  });
  assert.equal(crossOrigin.status, 403);
  await request("/api/settings/mcp/servers", "PUT", {
    name: "web_fixture", transport: "stdio", command: process.execPath,
    args: [fixture], enabled: true,
  });
  assert.equal((await request("/api/settings/mcp/servers")).servers.length, 1);
  assert.equal((await request("/api/settings/mcp/servers/web_fixture/connect", "POST", {})).server.status, "connected");
  assert.equal((await request("/api/settings/mcp/servers/web_fixture/tools")).tools[0].name, "echo");
  await request("/api/settings/mcp/servers/web_fixture", "PATCH", { enabled: false });
  assert.equal((await request("/api/settings/mcp/servers")).servers[0].status, "disabled");
  await request("/api/settings/mcp/servers/web_fixture", "DELETE");
  assert.deepEqual((await request("/api/settings/mcp/servers")).servers, []);
  console.log("MCP Web API smoke passed");
} finally {
  if (app) await app.close();
  // Runtime disposal stops tasks; close the test-only SQLite handle before
  // removing its temporary directory on Windows.
  runtime?.taskManager.store.close?.();
  const target = realpathSync(root);
  assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`));
  rmSync(target, { recursive: true, force: true });
}
