import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ArtifactService } from "../../artifacts/index.js";
import { openInBrowser } from "../../integrations/qgis/qgis-setup.js";
import { SessionManager } from "../../session/session-manager.js";
import type { AgentRuntime } from "../../runtime/agent-runtime.js";
import { RunManager } from "../../runtime/run-manager.js";
import type { MapStateUpdate } from "../../runtime/map-state-store.js";
import type {
  VisualizationKind,
  VisualizationStateUpdate,
} from "../../runtime/visualization-state-store.js";
import { ensureWorkspace } from "../../workspace/workspace.js";
import { SandboxPolicy } from "../../workspace/sandbox-policy.js";
import { WebSettingsService } from "./web-settings.js";
import {
  browseDirectories,
  getWorkspaceRoots,
  listWorkspaceFiles,
  readWorkspaceFile,
  resolveWorkspacePath,
} from "./workspace-browser.js";

export interface StartWebAppOptions {
  host?: string;
  port?: number;
  openBrowser?: boolean;
}

export interface WebAppHandle {
  address: string;
  close(): Promise<void>;
}

export async function startWebApp(
  runtime: AgentRuntime,
  options: StartWebAppOptions = {},
): Promise<WebAppHandle> {
  const host = options.host ?? "127.0.0.1";
  const preferredPort = options.port ?? 3170;
  const artifacts = new ArtifactService();
  const runs = new RunManager(runtime, {
    onArtifactPaths: (input) => {
      artifacts.registerPaths(input);
    },
  });
  const settings = new WebSettingsService(runtime);
  const sessions = new Map<string, SessionManager>();
  // The runtime needs an internal session before the user selects a project.
  // Do not expose that unpersisted bootstrap session as a real Web conversation.
  if (runtime.getSession().isPersisted()) {
    sessions.set(runtime.getSession().getSessionId(), runtime.getSession());
  }

  const server = Fastify({ logger: false, bodyLimit: 2_000_000 });
  registerApi(server, runtime, runs, artifacts, settings, sessions);
  await registerWebAssets(server);

  const port = await listenOnAvailablePort(server, host, preferredPort);
  const address = `http://${host}:${port}`;
  void runtime.modelRuntime.refreshAll().then(() => {
    runtime.modelRuntime.ensureSelection();
  }).catch(() => undefined);
  if (options.openBrowser !== false) openInBrowser(address);

  let closed = false;
  return {
    address,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      runs.dispose();
      await server.close();
      await runtime.dispose("web application stopped");
    },
  };
}

function registerApi(
  server: FastifyInstance,
  runtime: AgentRuntime,
  runs: RunManager,
  artifacts: ArtifactService,
  settings: WebSettingsService,
  sessions: Map<string, SessionManager>,
): void {
  server.get("/api/health", async () => ({ ok: true }));

  server.get("/api/bootstrap", async () => ({
    currentSessionId: sessions.has(runtime.getSession().getSessionId())
      ? runtime.getSession().getSessionId()
      : null,
    settings: settings.get(),
    options: settings.getOptions(),
    qgis: runtime.getQgisRuntime(),
    host: {
      mode: runtime.getHostProfile().mode,
      capabilities: runtime.getHostProfile().capabilities,
    },
    tools: runtime.toolRegistry.definitions().map((tool) => tool.function.name),
  }));

  server.get("/api/sessions", async () => {
    discoverSessions(sessions);
    return [...sessions.values()]
      .map(toSessionSummary)
      .sort((left, right) => Number(right.modifiedAt) - Number(left.modifiedAt));
  });

  server.post("/api/sessions", async (request, reply) => {
    const body = asRecord(request.body);
    const projectDir = readRequiredString(body.projectDir, "projectDir");
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      throw new Error("Project directory must be an existing directory.");
    }
    ensureWorkspace(projectDir);
    const session = SessionManager.create(projectDir);
    sessions.set(session.getSessionId(), session);
    runtime.setSession(session);
    reply.code(201);
    return toSessionDetails(session);
  });

  server.get("/api/directories", async (request) => {
    const query = request.query as { path?: string };
    return browseDirectories(query.path);
  });

  server.get("/api/sessions/:sessionId", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    return toSessionDetails(requireSession(sessionId, sessions, runtime));
  });

  server.post("/api/sessions/:sessionId/activate", async (request) => {
    if (runs.hasActiveRun()) throw new Error("Cannot switch sessions while a run is active.");
    const { sessionId } = request.params as { sessionId: string };
    const session = requireSession(sessionId, sessions, runtime);
    runtime.setSession(session);
    return toSessionDetails(session);
  });

  server.post("/api/sessions/:sessionId/clear", async (request) => {
    if (runs.hasActiveRun()) throw new Error("Cannot clear a session while an Agent run is active.");
    const { sessionId } = request.params as { sessionId: string };
    const session = requireSession(sessionId, sessions, runtime);
    session.clearConversation();
    return toSessionDetails(session);
  });

  server.delete("/api/sessions/:sessionId", async (request) => {
    if (runs.hasActiveRun()) throw new Error("Cannot delete a session while an Agent run is active.");
    const { sessionId } = request.params as { sessionId: string };
    const session = requireSession(sessionId, sessions, runtime);
    const deletingCurrent = runtime.getSession().getSessionId() === sessionId;
    const projectDir = session.getProjectDir();
    session.deletePersistedSession();
    sessions.delete(sessionId);
    artifacts.removeSession(sessionId);
    runtime.mapStateStore.removeSession(sessionId);
    runtime.visualizationStateStore.removeSession(sessionId);
    runtime.mapCommandBridge.removeSession(sessionId);

    if (deletingCurrent) {
      const replacement = SessionManager.create(projectDir);
      runtime.setSession(replacement);
    }
    return {
      deleted: true,
      currentSession: deletingCurrent ? null : toSessionDetails(runtime.getSession()),
    };
  });

  server.post("/api/sessions/:sessionId/runs", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = asRecord(request.body);
    const input = readRequiredString(body.input, "input");
    const session = requireSession(sessionId, sessions, runtime);
    if (runtime.getSession().getSessionId() !== sessionId) runtime.setSession(session);
    const run = runs.start(input);
    reply.code(202);
    return { ...run, eventsUrl: `/api/runs/${run.id}/events` };
  });

  server.get("/api/runs/:runId", async (request) => {
    const { runId } = request.params as { runId: string };
    const run = runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  });

  server.post("/api/runs/:runId/cancel", async (request) => {
    const { runId } = request.params as { runId: string };
    return { cancelled: runs.cancel(runId) };
  });

  server.get("/api/runs/:runId/events", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (!runs.get(runId)) {
      reply.code(404);
      return { error: "Run not found." };
    }
    const query = request.query as { afterSequence?: string };
    const lastEventId = request.headers["last-event-id"];
    const headerValue = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
    const headerSequence = headerValue?.split(":").at(-1);
    const afterSequence = parseSequence(query.afterSequence ?? headerSequence);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: ReturnType<RunManager["getEvents"]>[number]): void => {
      reply.raw.write(`id: ${event.eventId}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of runs.getEvents(runId, afterSequence)) send(event);
    const unsubscribe = runs.subscribe(runId, send);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  server.get("/api/tasks", async () => runtime.taskManager.list());
  server.get("/api/tasks/:taskId", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const task = runtime.taskManager.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  });
  server.post("/api/tasks/:taskId/cancel", async (request) => {
    const { taskId } = request.params as { taskId: string };
    return { cancelled: runtime.taskManager.cancel(taskId, "cancelled from Web UI") };
  });

  server.get("/api/interactions", async () =>
    runtime.humanInteractionBroker.getPending());
  server.post("/api/interactions/:requestId/respond", async (request) => {
    const { requestId } = request.params as { requestId: string };
    const body = asRecord(request.body);
    const action = readRequiredString(body.action, "action");
    if (!["approve", "reject", "select", "retry", "edit", "abort"].includes(action)) {
      throw new Error("Invalid interaction action.");
    }
    const resolved = runtime.humanInteractionBroker.resolve(requestId, {
      action: action as "approve" | "reject" | "select" | "retry" | "edit" | "abort",
      source: "web",
      ...(readOptionalString(body.optionId) ? { optionId: readOptionalString(body.optionId) } : {}),
      ...(body.editedInput !== undefined ? { editedInput: body.editedInput } : {}),
    });
    return { resolved };
  });

  server.get("/api/settings", async () => settings.get());
  server.get("/api/settings/options", async () => settings.getOptions());
  server.patch("/api/settings", async (request) => settings.update(request.body));
  server.post("/api/settings/providers/:providerId", async (request) => {
    const { providerId } = request.params as { providerId: string };
    const body = asRecord(request.body);
    return settings.configureProvider(providerId, readRequiredString(body.apiKey, "apiKey"));
  });
  server.post("/api/settings/providers/:providerId/refresh", async (request) => {
    const { providerId } = request.params as { providerId: string };
    return settings.refreshProvider(providerId);
  });
  server.delete("/api/settings/providers/:providerId", async (request) => {
    const { providerId } = request.params as { providerId: string };
    return settings.removeProvider(providerId);
  });
  server.get("/api/settings/qgis/candidates", async () => ({ candidates: await settings.getQgisCandidates() }));
  server.get("/api/settings/qgis/files", async (request) => {
    const query = request.query as { path?: string };
    return settings.browseQgisFiles(query.path);
  });
  server.put("/api/settings/qgis", async (request) => {
    const body = asRecord(request.body);
    return settings.configureQgis(readRequiredString(body.path, "path"));
  });
  server.delete("/api/settings/qgis", async () => settings.clearQgis());

  server.get("/api/sessions/:sessionId/map-commands", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const query = request.query as { clientId?: string };
    const clientId = readRequiredString(query.clientId, "clientId");
    requireSession(sessionId, sessions, runtime);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ sessionId, clientId })}\n\n`);
    const unregister = runtime.mapCommandBridge.registerClient(
      sessionId,
      clientId,
      (command) => {
        reply.raw.write(`event: command\ndata: ${JSON.stringify(command)}\n\n`);
      },
    );
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unregister();
    });
  });
  server.post("/api/sessions/:sessionId/map-command-results", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    requireSession(sessionId, sessions, runtime);
    const body = asRecord(request.body);
    const ok = readBoolean(body.ok, "ok");
    const accepted = runtime.mapCommandBridge.resolveResult(
      sessionId,
      readRequiredString(body.clientId, "clientId"),
      {
        id: readRequiredString(body.id, "id"),
        ok,
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(readOptionalString(body.error) ? { error: readOptionalString(body.error) } : {}),
      },
    );
    return { accepted };
  });

  server.get("/api/sessions/:sessionId/map-state", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    requireSession(sessionId, sessions, runtime);
    return {
      active: runtime.mapStateStore.isActive(sessionId),
      state: runtime.mapStateStore.get(sessionId),
    };
  });
  server.put("/api/sessions/:sessionId/map-state", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    requireSession(sessionId, sessions, runtime);
    return runtime.mapStateStore.update(sessionId, parseMapStateUpdate(request.body));
  });
  server.delete("/api/sessions/:sessionId/map-state", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    requireSession(sessionId, sessions, runtime);
    const body = asRecord(request.body);
    return {
      removed: runtime.mapStateStore.removeClient(
        sessionId,
        readRequiredString(body.clientId, "clientId"),
      ),
    };
  });

  server.get("/api/sessions/:sessionId/visualization-state", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    requireSession(sessionId, sessions, runtime);
    return {
      active: runtime.visualizationStateStore.isActive(sessionId),
      state: runtime.visualizationStateStore.get(sessionId),
    };
  });
  server.put("/api/sessions/:sessionId/visualization-state", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    requireSession(sessionId, sessions, runtime);
    return runtime.visualizationStateStore.update(
      sessionId,
      parseVisualizationStateUpdate(request.body),
    );
  });
  server.delete("/api/sessions/:sessionId/visualization-state", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    requireSession(sessionId, sessions, runtime);
    const body = asRecord(request.body);
    return {
      removed: runtime.visualizationStateStore.removeClient(
        sessionId,
        readRequiredString(body.clientId, "clientId"),
      ),
    };
  });

  server.get("/api/sessions/:sessionId/workspace", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = requireSession(sessionId, sessions, runtime);
    return {
      projectDir: session.getProjectDir(),
      workspaceDir: session.getWorkspaceDir(),
      roots: getWorkspaceRoots(session),
    };
  });
  server.get("/api/sessions/:sessionId/files", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const query = request.query as { rootId?: string; path?: string };
    const session = requireSession(sessionId, sessions, runtime);
    return listWorkspaceFiles(session, query.rootId ?? "workspace", query.path ?? "");
  });
  server.get("/api/sessions/:sessionId/files/content", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const query = request.query as { rootId?: string; path?: string };
    const session = requireSession(sessionId, sessions, runtime);
    return readWorkspaceFile(
      session,
      query.rootId ?? "workspace",
      readRequiredString(query.path, "path"),
    );
  });
  server.post("/api/sessions/:sessionId/artifacts", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = asRecord(request.body);
    const session = requireSession(sessionId, sessions, runtime);
    const requestedPath = readOptionalString(body.absolutePath);
    const path = requestedPath
      ? resolveAgentArtifactPath(session, requestedPath)
      : resolveWorkspacePath(
          session,
          readRequiredString(body.rootId, "rootId"),
          readRequiredString(body.path, "path"),
        ).path;
    const [artifact] = artifacts.registerPaths({ sessionId, paths: [path] });
    reply.code(201);
    return artifact;
  });

  server.get("/api/artifacts", async (request) => {
    const query = request.query as { sessionId?: string };
    return artifacts.list(query.sessionId);
  });
  server.get("/api/artifacts/:artifactId", async (request) => {
    const { artifactId } = request.params as { artifactId: string };
    const artifact = artifacts.get(artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    return artifact;
  });
  server.get("/api/artifacts/:artifactId/content", async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    const artifact = artifacts.getInternal(artifactId);
    if (!artifact || artifact.status !== "ready") {
      reply.code(404);
      return { error: "Artifact not found." };
    }
    const session = requireSession(artifact.sessionId, sessions, runtime);
    const policy = SandboxPolicy.fromWorkspace(
      session.getWorkspaceDir(),
      session.getProjectDir(),
    );
    policy.assertReadable(artifact.path);
    reply.type(artifact.contentType);
    return reply.send(createReadStream(artifact.path));
  });

  server.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/iu.test(message) ? 404 : 400;
    void reply.code(status).send({ error: message });
  });
}

function resolveAgentArtifactPath(session: SessionManager, requestedPath: string): string {
  const path = resolve(session.getProjectDir(), requestedPath);
  const policy = SandboxPolicy.fromWorkspace(session.getWorkspaceDir(), session.getProjectDir());
  policy.assertReadable(path);
  return path;
}

async function registerWebAssets(server: FastifyInstance): Promise<void> {
  const webRoot = resolve(process.cwd(), "dist", "web");
  if (!existsSync(resolve(webRoot, "index.html"))) {
    server.get("/", async (_request, reply) => {
      reply.type("text/html; charset=utf-8");
      return "<h1>Geo-agent Web UI is not built.</h1><p>Run <code>npm run build:web</code>.</p>";
    });
    return;
  }
  await server.register(fastifyStatic, { root: webRoot, prefix: "/" });
  server.get("/settings", async (_request, reply) => reply.sendFile("index.html"));
}

async function listenOnAvailablePort(
  server: FastifyInstance,
  host: string,
  preferredPort: number,
): Promise<number> {
  let lastError: unknown;
  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    try {
      await server.listen({ host, port });
      return port;
    } catch (error) {
      lastError = error;
      if (!isAddressInUse(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No available Web UI port.");
}

function discoverSessions(sessions: Map<string, SessionManager>): void {
  for (const info of SessionManager.listAll()) {
    if (!sessions.has(info.id)) sessions.set(info.id, SessionManager.open(info.path));
  }
}

function requireSession(
  id: string,
  sessions: Map<string, SessionManager>,
  runtime: AgentRuntime,
): SessionManager {
  if (runtime.getSession().getSessionId() === id) return runtime.getSession();
  const session = sessions.get(id);
  if (!session) throw new Error(`Session not found: ${id}`);
  return session;
}

function toSessionSummary(session: SessionManager): Record<string, unknown> {
  const info = session.getInfo();
  return {
    id: info.id,
    title: info.firstMessage?.slice(0, 60) || "新会话",
    projectDir: session.getProjectDir(),
    workspaceDir: session.getWorkspaceDir(),
    createdAt: info.createdAt,
    modifiedAt: info.modifiedAt,
    messageCount: info.messageCount,
  };
}

function toSessionDetails(session: SessionManager): Record<string, unknown> {
  return {
    ...toSessionSummary(session),
    messages: session.getEntries()
      .filter((entry) => entry.type === "message")
      .map((entry) => ({ id: entry.id, timestamp: entry.timestamp, ...entry.message })),
  };
}

function parseSequence(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be an object.");
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function parseMapStateUpdate(value: unknown): MapStateUpdate {
  const record = asRecord(value);
  const layers = Array.isArray(record.layers)
    ? record.layers.slice(0, 100).map((item, index) => {
        const layer = asRecord(item);
        return {
          id: readRequiredString(layer.id, `layers[${index}].id`),
          name: readRequiredString(layer.name, `layers[${index}].name`),
          visible: readBoolean(layer.visible, `layers[${index}].visible`),
          ...(readOptionalString(layer.format)
            ? { format: readOptionalString(layer.format) }
            : {}),
        };
      })
    : [];
  const selectionRecord = record.selection === undefined
    ? undefined
    : asRecord(record.selection);
  const selection = selectionRecord
    ? {
        layerId: readRequiredString(selectionRecord.layerId, "selection.layerId"),
        ...(typeof selectionRecord.featureId === "string" || typeof selectionRecord.featureId === "number"
          ? { featureId: selectionRecord.featureId }
          : {}),
        ...(readOptionalString(selectionRecord.geometryType)
          ? { geometryType: readOptionalString(selectionRecord.geometryType) }
          : {}),
        ...(isPlainRecord(selectionRecord.properties)
          ? { properties: selectionRecord.properties }
          : {}),
      }
    : undefined;

  return {
    clientId: readRequiredString(record.clientId, "clientId"),
    center: readNumberTuple(record.center, 2, "center"),
    zoom: readFiniteNumber(record.zoom, "zoom"),
    bounds: readNumberTuple(record.bounds, 4, "bounds"),
    ...(record.bearing !== undefined
      ? { bearing: readFiniteNumber(record.bearing, "bearing") }
      : {}),
    ...(record.pitch !== undefined
      ? { pitch: readFiniteNumber(record.pitch, "pitch") }
      : {}),
    layers,
    ...(selection ? { selection } : {}),
  };
}

function parseVisualizationStateUpdate(value: unknown): VisualizationStateUpdate {
  const record = asRecord(value);
  if (!Array.isArray(record.tabs)) throw new Error("tabs must be an array.");
  const allowedKinds = new Set<VisualizationKind>([
    "map", "markdown", "html", "csv", "json", "text", "image",
  ]);
  const tabs = record.tabs.slice(0, 30).map((value, index) => {
    const tab = asRecord(value);
    const kind = readRequiredString(tab.kind, `tabs[${index}].kind`) as VisualizationKind;
    if (!allowedKinds.has(kind)) throw new Error(`Unsupported visualization kind: ${kind}`);
    return {
      id: readRequiredString(tab.id, `tabs[${index}].id`),
      kind,
      title: readRequiredString(tab.title, `tabs[${index}].title`),
      ...(readOptionalString(tab.sourcePath) ? { sourcePath: readOptionalString(tab.sourcePath) } : {}),
      ...(readOptionalString(tab.artifactId) ? { artifactId: readOptionalString(tab.artifactId) } : {}),
      closable: kind === "map" ? false : readBoolean(tab.closable, `tabs[${index}].closable`),
    };
  });
  if (!tabs.some((tab) => tab.kind === "map")) {
    throw new Error("The visualization workspace must include the permanent map tab.");
  }
  return {
    clientId: readRequiredString(record.clientId, "clientId"),
    activeTabId: readRequiredString(record.activeTabId, "activeTabId"),
    tabs,
  };
}

function readNumberTuple<TLength extends 2 | 4>(
  value: unknown,
  length: TLength,
  name: string,
): TLength extends 2 ? [number, number] : [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${name} must contain ${length} numbers.`);
  }
  const numbers = value.map((item, index) => readFiniteNumber(item, `${name}[${index}]`));
  return numbers as TLength extends 2
    ? [number, number]
    : [number, number, number, number];
}

function readFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
