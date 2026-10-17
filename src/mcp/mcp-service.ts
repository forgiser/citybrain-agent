import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getCityBrainDir } from "../auth/auth-storage.js";
import { validateToolSchema } from "../tools/core/contracts/tool-preflight.js";

export type McpServerConfig = {
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  description?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Only explicitly named variables are passed to a local server. */
  envVars?: string[];
  url?: string;
  /** Header name -> environment variable name; secret values are never persisted. */
  headerEnv?: Record<string, string>;
};

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpServerView extends McpServerConfig {
  status: "disabled" | "disconnected" | "connecting" | "connected" | "error";
  toolCount?: number;
  error?: string;
}

interface Connection {
  client: Client;
  tools: McpToolInfo[];
}

const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u;
const ENV_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const MAX_SERVERS = 32;
const MAX_TOOLS = 200;

/** Shared MCP configuration, connections, discovery, and execution for CLI/Web/Agent. */
export class McpService {
  private configs = new Map<string, McpServerConfig>();
  private connections = new Map<string, Connection>();
  private connecting = new Map<string, Promise<Connection>>();
  private errors = new Map<string, string>();

  constructor(private readonly configPath = join(getCityBrainDir(), "mcp-servers.json")) {
    this.load();
  }

  list(): McpServerView[] {
    return [...this.configs.values()].map((config) => ({
      ...structuredClone(config),
      status: !config.enabled ? "disabled"
        : this.connections.has(config.name) ? "connected"
        : this.connecting.has(config.name) ? "connecting"
        : this.errors.has(config.name) ? "error" : "disconnected",
      ...(this.connections.has(config.name)
        ? { toolCount: this.connections.get(config.name)!.tools.length }
        : {}),
      ...(this.errors.has(config.name) ? { error: this.errors.get(config.name) } : {}),
    }));
  }

  summary(): string {
    const servers = this.list();
    if (servers.length === 0) return "No MCP servers configured.";
    return servers.map((server) =>
      `${server.name} (${server.transport}, ${server.status}${server.toolCount === undefined ? "" : `, ${server.toolCount} tools`})${server.description ? `: ${server.description.replace(/\s+/gu, " ").slice(0, 120)}` : ""}`
    ).join("\n");
  }

  isConnected(name: string): boolean {
    return this.connections.has(name);
  }

  async upsert(input: unknown): Promise<McpServerView> {
    const config = validateConfig(input);
    if (!this.configs.has(config.name) && this.configs.size >= MAX_SERVERS) {
      throw new Error(`MCP server limit reached (${MAX_SERVERS}).`);
    }
    await this.disconnect(config.name);
    this.configs.set(config.name, config);
    this.errors.delete(config.name);
    this.save();
    return this.requireView(config.name);
  }

  async remove(name: string): Promise<boolean> {
    await this.disconnect(name);
    this.errors.delete(name);
    const removed = this.configs.delete(name);
    if (removed) this.save();
    return removed;
  }

  async setEnabled(name: string, enabled: boolean): Promise<McpServerView> {
    const config = this.requireConfig(name);
    if (!enabled) await this.disconnect(name);
    config.enabled = enabled;
    this.errors.delete(name);
    this.save();
    return this.requireView(name);
  }

  async connect(name: string): Promise<McpServerView> {
    await this.ensureConnection(name);
    return this.requireView(name);
  }

  async disconnect(name: string): Promise<void> {
    const pending = this.connecting.get(name);
    if (pending) await pending.catch(() => undefined);
    const connection = this.connections.get(name);
    this.connections.delete(name);
    if (connection) await connection.client.close();
  }

  async listTools(name: string, refresh = false): Promise<McpToolInfo[]> {
    const connection = await this.ensureConnection(name);
    if (refresh) connection.tools = await this.discover(connection.client);
    return structuredClone(connection.tools);
  }

  async inspectTool(name: string, toolName: string): Promise<McpToolInfo> {
    const tools = await this.listTools(name);
    const tool = tools.find((entry) => entry.name === toolName);
    if (!tool) throw new Error(`MCP tool not found: ${name}/${toolName}. Refresh discovery if the server changed.`);
    return tool;
  }

  async callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const connection = await this.ensureConnection(name);
    const tool = await this.inspectTool(name, toolName);
    const validation = validateToolSchema(tool.inputSchema, args);
    if (!validation.ok) {
      throw new Error(`Invalid arguments for MCP tool ${name}/${toolName}: ${validation.errors.join("; ")}`);
    }
    const result = await connection.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { signal, timeout: 120_000 },
    );
    const blocks = Array.isArray(result.content)
      ? result.content as Array<Record<string, unknown>> : [];
    const rendered = blocks.map((block) => {
      if (block.type === "text") return String(block.text ?? "");
      if (block.type === "resource_link") return `${String(block.name)}: ${String(block.uri)}`;
      if (block.type === "resource") return JSON.stringify(block.resource);
      return `[${String(block.type)} content omitted; ${"mimeType" in block ? String(block.mimeType) : "binary"}]`;
    }).join("\n");
    if (result.isError) throw new Error(rendered || `${name}/${toolName} returned an MCP tool error.`);
    return rendered || JSON.stringify(result.structuredContent ?? result);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)));
  }

  private async ensureConnection(name: string): Promise<Connection> {
    const config = this.requireConfig(name);
    if (!config.enabled) throw new Error(`MCP server ${name} is disabled.`);
    const current = this.connections.get(name);
    if (current) return current;
    const pending = this.connecting.get(name);
    if (pending) return pending;
    const promise = this.open(config);
    this.connecting.set(name, promise);
    try {
      const connection = await promise;
      this.connections.set(name, connection);
      this.errors.delete(name);
      return connection;
    } catch (error) {
      this.errors.set(name, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.connecting.delete(name);
    }
  }

  private async open(config: McpServerConfig): Promise<Connection> {
    const client = new Client({ name: "citybrain-agent", version: "0.1.0" });
    const transport = config.transport === "stdio"
      ? new StdioClientTransport({
        command: config.command!,
        args: config.args ?? [],
        cwd: config.cwd,
        stderr: "pipe",
        env: {
          ...getDefaultEnvironment(),
          ...Object.fromEntries((config.envVars ?? []).map((key) => {
            const value = process.env[key];
            if (value === undefined) throw new Error(`Environment variable ${key} is not set.`);
            return [key, value];
          })),
        },
      })
      : new StreamableHTTPClientTransport(new URL(config.url!), {
        requestInit: {
          headers: Object.fromEntries(Object.entries(config.headerEnv ?? {}).map(([header, envName]) => {
            const value = process.env[envName];
            if (value === undefined) throw new Error(`Environment variable ${envName} is not set.`);
            return [header, value];
          })),
        },
      });
    try {
      await client.connect(transport, { timeout: 30_000 });
      const tools = await this.discover(client);
      client.onclose = () => {
        if (this.connections.get(config.name)?.client === client) {
          this.connections.delete(config.name);
          this.errors.set(config.name, "MCP connection closed.");
        }
      };
      return { client, tools };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async discover(client: Client): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
      for (const tool of page.tools) {
        if (tools.length >= MAX_TOOLS) throw new Error(`MCP discovery exceeded ${MAX_TOOLS} tools.`);
        tools.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as Record<string, unknown>,
          ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
        });
      }
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new Error("MCP server repeated a discovery cursor.");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return tools;
  }

  private requireConfig(name: string): McpServerConfig {
    const config = this.configs.get(name);
    if (!config) throw new Error(`MCP server not found: ${name}.`);
    return config;
  }

  private requireView(name: string): McpServerView {
    const view = this.list().find((entry) => entry.name === name);
    if (!view) throw new Error(`MCP server not found: ${name}.`);
    return view;
  }

  private load(): void {
    if (!existsSync(this.configPath)) return;
    const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("MCP config must be an array.");
    for (const item of parsed) {
      if (this.configs.size >= MAX_SERVERS) throw new Error(`MCP config exceeds ${MAX_SERVERS} servers.`);
      const config = validateConfig(item);
      if (this.configs.has(config.name)) throw new Error(`Duplicate MCP server: ${config.name}.`);
      this.configs.set(config.name, config);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify([...this.configs.values()], null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.configPath);
  }
}

function validateConfig(input: unknown): McpServerConfig {
  if (!isRecord(input) || typeof input.name !== "string" || !NAME.test(input.name)) {
    throw new Error("MCP name must start with a letter and contain only letters, digits, _ or - (max 64). ");
  }
  if (input.transport !== "stdio" && input.transport !== "http") {
    throw new Error("MCP transport must be stdio or http.");
  }
  const base: McpServerConfig = {
    name: input.name,
    transport: input.transport,
    enabled: input.enabled === undefined ? true : input.enabled === true,
    ...(typeof input.description === "string" && input.description.trim()
      ? { description: input.description.trim().slice(0, 500) } : {}),
  };
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new Error("MCP enabled must be boolean.");
  }
  if (input.transport === "stdio") {
    if (typeof input.command !== "string" || !input.command.trim()) {
      throw new Error("stdio MCP requires a command.");
    }
    if (input.args !== undefined && (!Array.isArray(input.args) ||
      input.args.some((arg) => typeof arg !== "string"))) {
      throw new Error("MCP args must be a string array.");
    }
    if (input.envVars !== undefined && (!Array.isArray(input.envVars) ||
      input.envVars.some((name) => typeof name !== "string" || !ENV_NAME.test(name)))) {
      throw new Error("MCP envVars must contain valid environment variable names.");
    }
    return {
      ...base,
      command: input.command.trim(),
      args: input.args as string[] | undefined,
      ...(typeof input.cwd === "string" && input.cwd.trim() ? { cwd: input.cwd.trim() } : {}),
      envVars: input.envVars as string[] | undefined,
    };
  }
  if (typeof input.url !== "string") throw new Error("HTTP MCP requires a URL.");
  const url = new URL(input.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP URL must use http or https.");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())) {
    throw new Error("Remote MCP services must use HTTPS; plain HTTP is allowed only on loopback.");
  }
  if (url.username || url.password) throw new Error("Put HTTP credentials in environment variables, not the URL.");
  if (input.headerEnv !== undefined && (!isRecord(input.headerEnv) ||
    Object.entries(input.headerEnv).some(([header, name]) =>
      !HEADER_NAME.test(header) || typeof name !== "string" || !ENV_NAME.test(name)))) {
    throw new Error("headerEnv must map HTTP header names to environment variable names.");
  }
  return { ...base, url: url.toString(), headerEnv: input.headerEnv as Record<string, string> | undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
