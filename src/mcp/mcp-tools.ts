import type { ToolSpec } from "../tools/core/contracts/tool-spec.js";
import type { McpService } from "./mcp-service.js";

const stringField = { type: "string" };

export function createMcpTools(service: McpService): ToolSpec[] {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "mcp_list_servers",
          description: "List configured MCP servers, connection states and brief descriptions. Use this to choose a server before discovering its tools.",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => JSON.stringify(service.list().map((server) => ({
        name: server.name,
        description: server.description,
        transport: server.transport,
        status: server.status,
        toolCount: server.toolCount,
        error: server.error,
      })), null, 2),
      metadata: { source: "mcp", isReadOnly: () => true, isConcurrencySafe: () => true },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "mcp_list_tools",
          description: "Connect to one configured MCP server and discover its tool names and short descriptions. Inspect a selected tool before calling it.",
          parameters: {
            type: "object",
            properties: { server: stringField, refresh: { type: "boolean" } },
            required: ["server"],
          },
        },
      },
      handler: async (input) => {
        const args = record(input);
        const server = requiredString(args.server, "server");
        const tools = await service.listTools(server, args.refresh === true);
        return JSON.stringify(tools.map(({ name, description }) => ({ name, description })), null, 2);
      },
      metadata: {
        source: "mcp", isReadOnly: () => true, isConcurrencySafe: () => false,
        requiresUserInteraction: (input) => !service.isConnected(String(record(input).server ?? "")),
        maxResultSizeChars: 20_000,
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "mcp_inspect_tool",
          description: "Read one discovered MCP tool's complete input schema and annotations before calling it.",
          parameters: {
            type: "object",
            properties: { server: stringField, tool: stringField },
            required: ["server", "tool"],
          },
        },
      },
      handler: async (input) => {
        const args = record(input);
        return JSON.stringify(await service.inspectTool(
          requiredString(args.server, "server"),
          requiredString(args.tool, "tool"),
        ), null, 2);
      },
      metadata: {
        source: "mcp", isReadOnly: () => true, isConcurrencySafe: () => false,
        requiresUserInteraction: (input) => !service.isConnected(String(record(input).server ?? "")),
        maxResultSizeChars: 20_000,
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "mcp_call_tool",
          description: "Execute a named tool on a configured MCP server after inspecting its schema. Remote MCP tools can have effects outside the workspace, so user confirmation is required for each call.",
          parameters: {
            type: "object",
            properties: {
              server: stringField,
              tool: stringField,
              arguments: { type: "object", additionalProperties: true },
            },
            required: ["server", "tool", "arguments"],
          },
        },
      },
      handler: async (input, context) => {
        const args = record(input);
        return service.callTool(
          requiredString(args.server, "server"),
          requiredString(args.tool, "tool"),
          record(args.arguments),
          context?.signal,
        );
      },
      metadata: {
        source: "mcp", isReadOnly: () => false, isDestructive: () => true,
        isConcurrencySafe: () => false, interruptBehavior: "cancel",
        requiresUserInteraction: () => true,
        maxResultSizeChars: 30_000,
      },
    },
  ];
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("MCP tool arguments must be an object.");
  }
  return input as Record<string, unknown>;
}

function requiredString(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} is required.`);
  return input.trim();
}
