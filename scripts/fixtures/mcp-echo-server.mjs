import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "citybrain-echo-fixture", version: "1.0.0" }, {
  capabilities: { tools: {} },
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "echo",
    description: "Return the supplied message.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "echo") throw new Error("Unknown tool.");
  return { content: [{ type: "text", text: String(request.params.arguments?.message ?? "") }] };
});
await server.connect(new StdioServerTransport());
