import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ToolRegistry } from "../tools/core/execution/tool-registry.js";
import type { TaskManager, TaskSnapshot } from "../task/index.js";
import type { WorkflowDefinition, WorkflowExecution, WorkflowNode } from "./workflow-types.js";

type JsonRecord = Record<string, unknown>;
const REPLAYABLE_TOOLS = new Set(["run_qgis_algorithm"]);

export class WorkflowService {
  constructor(private readonly getWorkspaceDir: () => string, private readonly tools: ToolRegistry) {}

  submit(taskManager: TaskManager, id: string): TaskSnapshot {
    const definition = this.get(id);
    return taskManager.submit({
      name: `Workflow: ${definition.name}`,
      description: `Run ${definition.nodes.length} processing steps`,
      deduplicationKey: `workflow:${definition.workspaceDir}:${id}`,
      resourceKeys: [`workflow:${definition.workspaceDir}`],
      recoveryKey: "workflow_execution",
      recoveryPayload: { workflowId: id, workspaceDir: definition.workspaceDir },
      metadata: { kind: "workflow", workspaceDir: definition.workspaceDir, detached: true },
      runner: this.createRunner(id),
    });
  }

  recover(taskManager: TaskManager): TaskSnapshot[] {
    const workspaceDir = resolve(this.getWorkspaceDir());
    return taskManager.recover(
      "workflow_execution",
      (payload) => this.createRunner(String(payload.workflowId)),
      (task) => task.recoveryPayload?.workspaceDir === workspaceDir,
    );
  }

  private createRunner(id: string): NonNullable<Parameters<TaskManager["submit"]>[0]["runner"]> {
    return async (task) => {
      const result = await this.execute(id, {
        signal: task.signal,
        onNodeCompleted: (nodeId, completed, total) => task.reportProgress({
          phase: "running", message: `Completed ${nodeId} (${completed}/${total})`,
          current: completed, total, percent: Math.round(100 * completed / total),
        }),
      });
      const definition = this.get(id);
      task.addArtifacts(definition.nodes.flatMap((node) => node.outputPaths));
      return result;
    };
  }

  list(): WorkflowDefinition[] {
    const indexPath = this.indexPath();
    if (!existsSync(indexPath)) return [];
    const ids = JSON.parse(readFileSync(indexPath, "utf8")) as string[];
    return ids.flatMap((id) => { try { return [this.get(id)]; } catch { return []; } });
  }

  get(id: string): WorkflowDefinition {
    const path = this.definitionPath(id);
    if (!existsSync(path)) throw new Error(`Workflow not found: ${id}`);
    const definition = JSON.parse(readFileSync(path, "utf8")) as WorkflowDefinition;
    if (definition.workspaceDir !== resolve(this.getWorkspaceDir())) throw new Error("Workflow belongs to another workspace.");
    return definition;
  }

  getExecution(id: string): WorkflowExecution | undefined {
    const path = this.executionPath(id);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as WorkflowExecution : undefined;
  }

  /** Extract only successful, explicitly replayable processing calls. */
  createFromRun(runId: string, name = `Workflow ${runId.slice(0, 8)}`): WorkflowDefinition {
    if (!/^[a-zA-Z0-9_-]{8,100}$/u.test(runId)) throw new Error("Invalid Agent run id.");
    const workspaceDir = resolve(this.getWorkspaceDir());
    const path = join(workspaceDir, ".internal", "logs", "tool-execution.jsonl");
    if (!existsSync(path)) throw new Error("No tool execution log exists for this workspace.");
    const events = readFileSync(path, "utf8").split(/\r?\n/u).flatMap((line): JsonRecord[] => {
      try { const value = JSON.parse(line) as unknown; return isRecord(value) && value.runId === runId ? [value] : []; }
      catch { return []; }
    });
    const starts = new Map<string, JsonRecord>();
    const outputs = new Map<string, string[]>();
    const finished: JsonRecord[] = [];
    for (const event of events) {
      const executionId = typeof event.executionId === "string" ? event.executionId : "";
      if (event.phase === "start") starts.set(executionId, event);
      if (event.phase === "artifact" && event.status === "ready" && Array.isArray(event.artifactPaths)) {
        outputs.set(executionId, event.artifactPaths.filter((item): item is string => typeof item === "string"));
      }
      if (event.phase === "finish" && event.ok === true && REPLAYABLE_TOOLS.has(String(event.tool))) finished.push(event);
    }
    const nodes: WorkflowNode[] = [];
    const producer = new Map<string, string>();
    for (const finish of finished) {
      const start = starts.get(String(finish.executionId));
      if (!start || !isRecord(start.arguments) || hasRedaction(start.arguments)) continue;
      const id = `node-${nodes.length + 1}`;
      const outputPaths = (outputs.get(String(finish.executionId)) ?? inferQgisOutputs(start.arguments, workspaceDir))
        .map((path) => resolve(workspaceDir, path));
      const inputPaths = [...new Set([
        ...collectExistingPaths(start.arguments, workspaceDir),
        ...collectProducedPaths(start.arguments, workspaceDir, producer),
      ])].filter((path) => !outputPaths.includes(path));
      const dependencies = [...new Set(inputPaths.map((path) => producer.get(path)).filter((value): value is string => Boolean(value)))];
      nodes.push({
        id,
        tool: String(finish.tool),
        arguments: structuredClone(start.arguments),
        dependencies,
        inputPaths,
        outputPaths,
        cachePolicy: outputPaths.length > 0 ? "by-input-fingerprint" : "never",
        maximumAttempts: 1,
      });
      for (const path of outputPaths) producer.set(resolve(path), id);
    }
    if (nodes.length === 0) throw new Error("This Run has no successful, replayable QGIS processing steps.");
    const definition: WorkflowDefinition = {
      id: `workflow-${randomUUID()}`,
      version: 1,
      name: name.trim() || `Workflow ${runId.slice(0, 8)}`,
      sourceRunId: runId,
      workspaceDir,
      createdAt: new Date().toISOString(),
      nodes,
    };
    this.save(definition);
    return definition;
  }

  /** Save an explicitly reviewed workflow definition. Every node still passes ToolRegistry. */
  save(definition: WorkflowDefinition): void {
    if (definition.workspaceDir !== resolve(this.getWorkspaceDir())) throw new Error("Workflow workspace mismatch.");
    validateDefinition(definition);
    const ids = this.list().map((item) => item.id);
    writeAtomic(this.definitionPath(definition.id), definition);
    if (!ids.includes(definition.id)) writeAtomic(this.indexPath(), [...ids, definition.id]);
  }

  updateNodeArguments(id: string, nodeId: string, args: Record<string, unknown>): WorkflowDefinition {
    if (hasRedaction(args)) throw new Error("Workflow arguments contain redacted values.");
    const definition = this.get(id);
    const node = definition.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Workflow node not found: ${nodeId}`);
    const nextOutputs = node.tool === "run_qgis_algorithm" ? inferQgisOutputs(args, definition.workspaceDir) : [];
    for (const oldPath of node.outputPaths.filter((path) => !nextOutputs.includes(path))) {
      if (definition.nodes.some((other) => other.id !== nodeId && referencesPath(other.arguments, oldPath, definition.workspaceDir))) {
        throw new Error(`Output ${oldPath} is still referenced by another node. Update downstream inputs first.`);
      }
    }
    node.arguments = structuredClone(args);
    node.outputPaths = nextOutputs;
    node.cachePolicy = node.outputPaths.length > 0 ? "by-input-fingerprint" : "never";
    relinkNodes(definition);
    this.save(definition);
    return definition;
  }

  async execute(id: string, options: { signal?: AbortSignal; force?: boolean; onNodeCompleted?: (nodeId: string, completed: number, total: number) => void } = {}): Promise<WorkflowExecution> {
    const definition = this.get(id);
    validateDefinition(definition);
    const previous = this.getExecution(id);
    const execution: WorkflowExecution = {
      workflowId: id,
      startedAt: previous?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      nodes: { ...(previous?.nodes ?? {}) },
    };
    this.saveExecution(execution);
    try {
      const orderedNodes = topologicalOrder(definition.nodes);
      for (const [nodeIndex, node] of orderedNodes.entries()) {
        if (resolve(this.getWorkspaceDir()) !== definition.workspaceDir) throw new Error("Active workspace changed during workflow execution.");
        if (options.signal?.aborted) throw new Error("Workflow execution cancelled.");
        const sandbox = this.tools.getSandboxPolicy();
        for (const path of node.inputPaths) sandbox?.assertReadable(path);
        for (const path of node.outputPaths) sandbox?.assertWritable(path);
        const fingerprint = await fingerprintNode(node);
        const prior = execution.nodes[node.id];
        if (prior?.status === "running") {
          throw new Error(`${node.id}: the previous process stopped while this node was running. Inspect its output before manually starting another run; it will not be replayed automatically.`);
        }
        if (!options.force && node.cachePolicy === "by-input-fingerprint" && prior &&
          ["completed", "cached"].includes(prior.status) && prior.fingerprint === fingerprint &&
          node.outputPaths.length > 0 && node.outputPaths.every((path) => existsSync(path)) &&
          prior.outputFingerprint === await fingerprintPaths(node.outputPaths)) {
          execution.nodes[node.id] = { ...prior, status: "cached", updatedAt: new Date().toISOString() };
          this.saveExecution(execution);
          options.onNodeCompleted?.(node.id, nodeIndex + 1, orderedNodes.length);
          continue;
        }
        let error = "";
        execution.nodes[node.id] = {
          nodeId: node.id, status: "running", fingerprint, attempt: 0,
          updatedAt: new Date().toISOString(), outputPaths: [...node.outputPaths],
        };
        this.saveExecution(execution);
        for (let attempt = 1; attempt <= node.maximumAttempts; attempt += 1) {
          let staged: ReturnType<typeof stageNodeOutput>;
          let result;
          try {
            staged = stageNodeOutput(node, definition.workspaceDir);
            if (staged) sandbox?.assertWritable(staged.temporary);
            result = await this.tools.execute(node.tool, JSON.stringify(staged?.arguments ?? node.arguments), { signal: options.signal });
            if (result.ok && staged) {
              if (!existsSync(staged.temporary)) throw new Error(`Staged output is missing: ${staged.temporary}`);
              renameSync(staged.temporary, staged.final);
            }
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
            continue;
          } finally {
            if (staged && existsSync(staged.temporary)) unlinkSync(staged.temporary);
          }
          if (result.ok && node.outputPaths.every((path) => existsSync(path))) {
            execution.nodes[node.id] = {
              nodeId: node.id, status: "completed", fingerprint, attempt,
              updatedAt: new Date().toISOString(), outputPaths: [...node.outputPaths],
              outputFingerprint: await fingerprintPaths(node.outputPaths),
            };
            this.saveExecution(execution);
            options.onNodeCompleted?.(node.id, nodeIndex + 1, orderedNodes.length);
            error = "";
            break;
          }
          error = result.ok ? "Expected workflow output is missing." : result.content;
        }
        if (error) {
          execution.nodes[node.id] = {
            nodeId: node.id, status: "failed", fingerprint, attempt: node.maximumAttempts,
            updatedAt: new Date().toISOString(), outputPaths: [...node.outputPaths], error,
          };
          throw new Error(`${node.id}: ${error}`);
        }
      }
      execution.status = "completed";
    } catch (error) {
      execution.status = "failed";
      this.saveExecution(execution);
      throw error;
    }
    this.saveExecution(execution);
    return execution;
  }

  private saveExecution(execution: WorkflowExecution): void {
    execution.updatedAt = new Date().toISOString();
    writeAtomic(this.executionPath(execution.workflowId), execution);
  }

  private root(): string { return join(resolve(this.getWorkspaceDir()), ".internal", "workflows"); }
  private indexPath(): string { return join(this.root(), "index.json"); }
  private definitionPath(id: string): string { return join(this.root(), `${safeId(id)}.json`); }
  private executionPath(id: string): string { return join(this.root(), `${safeId(id)}.execution.json`); }
}

function safeId(id: string): string {
  if (!/^workflow-[a-f0-9-]{36}$/u.test(id)) throw new Error("Invalid workflow id.");
  return id;
}

function validateDefinition(definition: WorkflowDefinition): void {
  safeId(definition.id);
  if (!Array.isArray(definition.nodes) || definition.nodes.length === 0) throw new Error("Workflow has no nodes.");
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (!/^node-[a-zA-Z0-9_-]+$/u.test(node.id) || ids.has(node.id)) throw new Error(`Invalid or duplicate node id: ${node.id}`);
    if (!REPLAYABLE_TOOLS.has(node.tool)) throw new Error(`Tool is not enabled for workflow replay: ${node.tool}`);
    if (!Number.isSafeInteger(node.maximumAttempts) || node.maximumAttempts < 1 || node.maximumAttempts > 3) throw new Error("maximumAttempts must be 1 to 3.");
    ids.add(node.id);
  }
  topologicalOrder(definition.nodes);
}

function topologicalOrder(nodes: WorkflowNode[]): WorkflowNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: WorkflowNode[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (node: WorkflowNode): void => {
    if (visited.has(node.id)) return;
    if (visiting.has(node.id)) throw new Error("Workflow contains a dependency cycle.");
    visiting.add(node.id);
    for (const dependency of node.dependencies) {
      const parent = byId.get(dependency);
      if (!parent) throw new Error(`Missing workflow dependency: ${dependency}`);
      visit(parent);
    }
    visiting.delete(node.id);
    visited.add(node.id);
    result.push(node);
  };
  for (const node of nodes) visit(node);
  return result;
}

async function fingerprintNode(node: WorkflowNode): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify({ tool: node.tool, arguments: node.arguments }));
  hash.update(await fingerprintPaths(node.inputPaths));
  return hash.digest("hex");
}

async function fingerprintPaths(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(path);
    if (!existsSync(path)) { hash.update("missing"); continue; }
    await new Promise<void>((done, fail) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => { hash.update(chunk); });
      stream.once("end", done);
      stream.once("error", fail);
    });
  }
  return hash.digest("hex");
}

function collectExistingPaths(value: unknown, workspaceDir: string): string[] {
  const paths: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      const path = resolve(workspaceDir, item);
      if (existsSync(path) && statSync(path).isFile()) paths.push(path);
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (isRecord(item)) Object.values(item).forEach(visit);
  };
  visit(value);
  return [...new Set(paths)];
}

function collectProducedPaths(value: unknown, workspaceDir: string, producer: Map<string, string>): string[] {
  const paths: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      const path = resolve(workspaceDir, item);
      if (producer.has(path)) paths.push(path);
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (isRecord(item)) Object.values(item).forEach(visit);
  };
  visit(value);
  return paths;
}

function referencesPath(value: unknown, target: string, workspaceDir: string): boolean {
  if (typeof value === "string") return resolve(workspaceDir, value) === target;
  if (Array.isArray(value)) return value.some((item) => referencesPath(item, target, workspaceDir));
  return isRecord(value) && Object.values(value).some((item) => referencesPath(item, target, workspaceDir));
}

function relinkNodes(definition: WorkflowDefinition): void {
  const producer = new Map(definition.nodes.flatMap((node) => node.outputPaths.map((path): [string, string] => [path, node.id])));
  for (const node of definition.nodes) {
    node.inputPaths = [...new Set([
      ...collectExistingPaths(node.arguments, definition.workspaceDir),
      ...collectProducedPaths(node.arguments, definition.workspaceDir, producer),
    ])].filter((path) => !node.outputPaths.includes(path));
    node.dependencies = [...new Set(node.inputPaths.map((path) => producer.get(path)).filter((id): id is string => Boolean(id) && id !== node.id))];
  }
}

function inferQgisOutputs(args: JsonRecord, workspaceDir: string): string[] {
  if (!isRecord(args.parameters)) return [];
  return Object.entries(args.parameters).flatMap(([key, value]) =>
    /^(?:OUTPUT|OUTPUT_\w+|DESTINATION)$/iu.test(key) && typeof value === "string" && value.trim() ? [resolve(workspaceDir, value)] : []);
}

/** Keep a failed single-file processing step away from its committed output. */
function stageNodeOutput(node: WorkflowNode, workspaceDir: string): { arguments: JsonRecord; temporary: string; final: string } | undefined {
  if (node.outputPaths.length === 0) return undefined;
  if (node.outputPaths.length !== 1) throw new Error(`${node.id}: multiple outputs cannot be committed atomically.`);
  const final = node.outputPaths[0];
  const extension = extname(final).toLowerCase();
  if (![".geojson", ".json", ".gpkg", ".tif", ".tiff", ".csv", ".txt"].includes(extension)) {
    throw new Error(`${node.id}: output format ${extension || "unknown"} cannot be staged safely.`);
  }
  if (!isRecord(node.arguments.parameters)) throw new Error(`${node.id}: QGIS parameters are missing.`);
  const entries = Object.entries(node.arguments.parameters).filter(([key, value]) =>
    /^(?:OUTPUT|OUTPUT_\w+|DESTINATION)$/iu.test(key) && typeof value === "string" && resolve(workspaceDir, value) === final);
  if (entries.length !== 1) throw new Error(`${node.id}: cannot identify a unique output parameter for staging.`);
  mkdirSync(dirname(final), { recursive: true });
  const temporary = join(dirname(final), `.${basename(final, extension)}.workflow-${randomUUID()}${extension}`);
  return {
    arguments: { ...node.arguments, parameters: { ...node.arguments.parameters, [entries[0][0]]: temporary } },
    temporary,
    final,
  };
}

function hasRedaction(value: unknown): boolean {
  if (value === "[redacted]") return true;
  if (Array.isArray(value)) return value.some(hasRedaction);
  return isRecord(value) && Object.values(value).some(hasRedaction);
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  renameSync(temporary, path);
}
