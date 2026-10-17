import { appendFile, mkdir } from "node:fs/promises";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TaskEvent, TaskSnapshot } from "../task/index.js";

const MAX_TRACE_LOG_BYTES = 8 * 1024 * 1024;
const MAX_COMPACT_LOG_BYTES = 32 * 1024 * 1024;

export type ObservationKind = "run" | "model" | "tool" | "task" | "hitl" | "artifact" | "error" | "context";

export interface ObservationTimelineItem {
  id: string;
  timestamp: string;
  kind: ObservationKind;
  title: string;
  status?: string;
  runId?: string;
  taskId?: string;
  tool?: string;
  durationMs?: number;
  detail?: string;
}

export interface ObservationRunSummary {
  runId: string;
  startedAt?: string;
  endedAt?: string;
  status: string;
  turns: number;
  modelRequests: number;
  toolCalls: number;
  errors: number;
  totalTokens: number;
  durationMs?: number;
}

export interface ObservationToolSummary {
  name: string;
  calls: number;
  succeeded: number;
  failed: number;
  averageDurationMs: number;
  p95DurationMs: number;
  lastExecutedAt?: string;
}

export interface AgentObservationReport {
  generatedAt: string;
  workspaceDir: string;
  summary: {
    runs: number;
    modelRequests: number;
    toolCalls: number;
    toolSuccessRate: number;
    errors: number;
    hitlRequests: number;
    artifacts: number;
    activeTasks: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    contextCompactions: number;
    peakContextPercent: number;
    averageModelLatencyMs: number;
    averageToolDurationMs: number;
    p95ToolDurationMs: number;
  };
  runs: ObservationRunSummary[];
  tools: ObservationToolSummary[];
  activeTasks: Array<{
    id: string;
    name: string;
    status: string;
    runId?: string;
    detached: boolean;
    progress?: number;
    elapsedMs?: number;
  }>;
  timeline: ObservationTimelineItem[];
  logFiles: Array<{ name: string; path: string; size: number; loadedBytes: number; truncated: boolean; exists: boolean }>;
}

interface RuntimeTaskLogEvent {
  schemaVersion: 1;
  timestamp: string;
  kind: "task";
  eventType: TaskEvent["type"];
  taskId: string;
  name: string;
  status: string;
  runId?: string;
  toolCallId?: string;
  detached: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: { phase?: string; percent?: number; message?: string; elapsedMs?: number };
  artifactPaths: string[];
  error?: string;
}

type JsonRecord = Record<string, unknown>;

export class AgentObservabilityService {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly getWorkspaceDir: () => string,
    private readonly getTasks: () => TaskSnapshot[],
  ) {}

  recordTaskEvent(event: TaskEvent): Promise<void> {
    const task = event.task;
    const eventWorkspace = readString(task.metadata?.workspaceDir) ?? this.getWorkspaceDir();
    const eventPath = this.getPaths(eventWorkspace).tasks;
    const record: RuntimeTaskLogEvent = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      kind: "task",
      eventType: event.type,
      taskId: task.id,
      name: task.name,
      status: task.status,
      runId: readString(task.metadata?.runId),
      toolCallId: readString(task.metadata?.toolCallId),
      detached: task.metadata?.detached === true,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      progress: task.progress
        ? {
            phase: task.progress.phase,
            percent: task.progress.percent,
            message: task.progress.message?.slice(0, 1_000),
            elapsedMs: task.progress.elapsedMs,
          }
        : undefined,
      artifactPaths: task.artifactPaths.slice(0, 100),
      error: task.error?.message?.slice(0, 2_000) ?? task.cancellationReason?.slice(0, 2_000),
    };
    const line = `${JSON.stringify(record)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(eventPath), { recursive: true });
      await appendFile(eventPath, line, "utf8");
    }).catch(() => undefined);
    return this.writeQueue;
  }

  getReport(options: { limit?: number; runId?: string } = {}): AgentObservationReport {
    const limit = clamp(options.limit ?? 200, 20, 1_000);
    const paths = this.getPaths();
    const logs = {
      tools: readJsonLog(paths.tools, MAX_COMPACT_LOG_BYTES),
      contextUsage: readJsonLog(paths.contextUsage, MAX_COMPACT_LOG_BYTES),
      contextTrace: readJsonLog(paths.contextTrace, MAX_TRACE_LOG_BYTES),
      tasks: readJsonLog(paths.tasks, MAX_COMPACT_LOG_BYTES),
    };
    const toolEvents = logs.tools.events.filter((event) => matchesRun(event, options.runId));
    const traceEvents = logs.contextTrace.events.filter((event) => matchesRun(event, options.runId));
    const usageEvents = logs.contextUsage.events.filter((event) => matchesRun(event, options.runId));
    const taskEvents = logs.tasks.events.filter((event) => matchesRun(event, options.runId));
    const runMap = new Map<string, ObservationRunSummary>();
    const timeline: ObservationTimelineItem[] = [];

    const ensureRun = (runId: string): ObservationRunSummary => {
      const existing = runMap.get(runId);
      if (existing) return existing;
      const created: ObservationRunSummary = {
        runId,
        status: "unknown",
        turns: 0,
        modelRequests: 0,
        toolCalls: 0,
        errors: 0,
        totalTokens: 0,
      };
      runMap.set(runId, created);
      return created;
    };

    const toolDurations: number[] = [];
    const toolStats = new Map<string, { calls: number; succeeded: number; failed: number; durations: number[]; last?: string }>();
    let hitlRequests = 0;
    const artifacts = new Set<string>();
    for (const event of toolEvents) {
      const timestamp = readString(event.timestamp) ?? new Date(0).toISOString();
      const runId = readString(event.runId);
      const phase = readString(event.phase);
      const tool = readString(event.tool) ?? "unknown";
      const run = runId ? ensureRun(runId) : undefined;
      const turn = readNumber(event.turn);
      if (run && turn !== undefined) run.turns = Math.max(run.turns, turn + 1);
      if (phase === "state" && run) {
        const state = readString(event.state) ?? "unknown";
        if (!run.startedAt || state === "planning") run.startedAt = earlier(run.startedAt, timestamp);
        if (["completed", "failed", "aborted"].includes(state)) run.endedAt = later(run.endedAt, timestamp);
        run.status = state;
        timeline.push({ id: observationId("run", event), timestamp, kind: state === "failed" || state === "aborted" ? "error" : "run", title: `Agent ${state}`, status: state, runId, detail: readString(event.reason) });
      } else if (phase === "finish") {
        const duration = readNumber(event.durationMs) ?? 0;
        const ok = event.ok === true;
        const stats = toolStats.get(tool) ?? { calls: 0, succeeded: 0, failed: 0, durations: [] };
        stats.calls += 1;
        if (ok) stats.succeeded += 1; else stats.failed += 1;
        if (duration >= 0) { stats.durations.push(duration); toolDurations.push(duration); }
        stats.last = later(stats.last, timestamp);
        toolStats.set(tool, stats);
        if (run) { run.toolCalls += 1; if (!ok) run.errors += 1; }
        timeline.push({ id: observationId("tool", event), timestamp, kind: ok ? "tool" : "error", title: tool, status: ok ? "completed" : "failed", runId, taskId: readString(event.taskId), tool, durationMs: duration, detail: readString(event.toolUseSummary) ?? readString(event.error) });
      } else if (phase === "artifact") {
        for (const path of readStringArray(event.artifactPaths)) artifacts.add(path);
        timeline.push({ id: observationId("artifact", event), timestamp, kind: "artifact", title: `${tool} artifact`, status: readString(event.status), runId, taskId: readString(event.taskId), tool, detail: readStringArray(event.artifactPaths).join(", ") });
      } else if (phase === "lifecycle" && readString(event.stage)?.startsWith("human_created")) {
        hitlRequests += 1;
        timeline.push({ id: observationId("hitl", event), timestamp, kind: "hitl", title: readString(event.humanKind) ?? "Human interaction", status: "waiting", runId, detail: readString(event.detail) });
      } else if (phase === "lifecycle" && event.ok === false) {
        if (run) run.errors += 1;
        timeline.push({ id: observationId("error", event), timestamp, kind: "error", title: readString(event.errorCode) ?? `${tool} error`, status: "failed", runId, taskId: readString(event.taskId), tool, detail: readString(event.detail) });
      }
    }

    const requestTimes = new Map<string, number>();
    const observedModelRequests = new Map<string, string>();
    const modelLatencies: number[] = [];
    let modelRequests = 0;
    let contextCompactions = 0;
    for (const event of traceEvents) {
      const runId = readString(event.runId);
      if (!runId) continue;
      const run = ensureRun(runId);
      const phase = readString(event.phase);
      const timestamp = readString(event.timestamp) ?? new Date(0).toISOString();
      const key = `${runId}:${String(event.requestIndex ?? "")}`;
      if (phase === "request") {
        observedModelRequests.set(key, runId);
        requestTimes.set(key, Date.parse(timestamp));
        timeline.push({ id: observationId("model-request", event), timestamp, kind: "model", title: `${readString(event.provider) ?? "model"}/${readString(event.model) ?? "unknown"}`, status: "request", runId, detail: `${readNumber(event.contextTokens) ?? 0} context tokens` });
      } else if (phase === "response") {
        const started = requestTimes.get(key);
        const latency = started !== undefined ? Math.max(0, Date.parse(timestamp) - started) : undefined;
        if (latency !== undefined) modelLatencies.push(latency);
        timeline.push({ id: observationId("model-response", event), timestamp, kind: "model", title: `${readString(event.provider) ?? "model"}/${readString(event.model) ?? "unknown"}`, status: "response", runId, durationMs: latency, detail: `${readNumber(event.completionTokens) ?? 0} output tokens` });
      } else if (phase === "compaction") {
        contextCompactions += 1;
        timeline.push({ id: observationId("context", event), timestamp, kind: "context", title: "Context compaction", status: "completed", runId, detail: readString((event.compaction as JsonRecord | undefined)?.reason) });
      }
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let peakContextPercent = 0;
    const accountedRequests = new Set<string>();
    for (const event of usageEvents) {
      if (event.stage !== "after_response") continue;
      const runId = readString(event.runId);
      if (!runId) continue;
      const key = `${runId}:${String(event.requestIndex ?? "")}`;
      if (accountedRequests.has(key)) continue;
      accountedRequests.add(key);
      modelRequests += 1;
      ensureRun(runId).modelRequests += 1;
      const input = readNumber(event.inputTokens) ?? readNumber(event.promptTokens) ?? 0;
      const output = readNumber(event.outputTokens) ?? readNumber(event.completionTokens) ?? 0;
      const cacheRead = readNumber(event.cacheReadTokens) ?? 0;
      const cacheWrite = readNumber(event.cacheWriteTokens) ?? 0;
      const requestTotal = readNumber(event.totalTokens) ?? readNumber(event.requestTotalTokens) ?? input + output + cacheRead + cacheWrite;
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens += cacheRead;
      cacheWriteTokens += cacheWrite;
      totalTokens += requestTotal;
      peakContextPercent = Math.max(peakContextPercent, readNumber(event.percent) ?? 0);
      ensureRun(runId).totalTokens += requestTotal;
    }
    for (const [key, runId] of observedModelRequests) {
      if (accountedRequests.has(key)) continue;
      modelRequests += 1;
      ensureRun(runId).modelRequests += 1;
    }

    for (const event of taskEvents) {
      const timestamp = readString(event.timestamp) ?? new Date(0).toISOString();
      const status = readString(event.status) ?? "unknown";
      const runId = readString(event.runId);
      if (runId) ensureRun(runId);
      if (["submitted", "started", "completed", "failed", "cancelled", "timed_out", "orphaned", "recovered"].includes(readString(event.eventType) ?? "")) {
        timeline.push({ id: observationId("task", event), timestamp, kind: status === "failed" || status === "timed_out" || status === "orphaned" ? "error" : "task", title: readString(event.name) ?? "Background task", status, runId, taskId: readString(event.taskId), detail: event.detached === true ? "detached background task" : undefined });
      }
    }

    const runs = [...runMap.values()].map((run) => ({
      ...run,
      durationMs: run.startedAt && run.endedAt ? Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)) : undefined,
    })).sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
    const tools = [...toolStats.entries()].map(([name, stats]) => ({
      name,
      calls: stats.calls,
      succeeded: stats.succeeded,
      failed: stats.failed,
      averageDurationMs: average(stats.durations),
      p95DurationMs: percentile(stats.durations, 0.95),
      lastExecutedAt: stats.last,
    })).sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
    const workspaceDir = resolve(this.getWorkspaceDir());
    const activeTasks = this.getTasks().filter((task) => !["completed", "failed", "cancelled", "timed_out", "orphaned"].includes(task.status)).filter((task) => {
      const taskWorkspace = readString(task.metadata?.workspaceDir);
      return !taskWorkspace || resolve(taskWorkspace) === workspaceDir;
    }).filter((task) => !options.runId || task.metadata?.runId === options.runId).map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status,
      runId: readString(task.metadata?.runId),
      detached: task.metadata?.detached === true,
      progress: task.progress?.percent,
      elapsedMs: task.progress?.elapsedMs,
    }));
    const errors = timeline.filter((item) => item.kind === "error").length;
    const totalToolCalls = tools.reduce((sum, tool) => sum + tool.calls, 0);
    const succeededTools = tools.reduce((sum, tool) => sum + tool.succeeded, 0);

    return {
      generatedAt: new Date().toISOString(),
      workspaceDir,
      summary: {
        runs: runs.length,
        modelRequests,
        toolCalls: totalToolCalls,
        toolSuccessRate: totalToolCalls > 0 ? (succeededTools / totalToolCalls) * 100 : 0,
        errors,
        hitlRequests,
        artifacts: artifacts.size,
        activeTasks: activeTasks.length,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        contextCompactions,
        peakContextPercent,
        averageModelLatencyMs: average(modelLatencies),
        averageToolDurationMs: average(toolDurations),
        p95ToolDurationMs: percentile(toolDurations, 0.95),
      },
      runs: runs.slice(0, 100),
      tools: tools.slice(0, 100),
      activeTasks,
      timeline: timeline.sort((left, right) => right.timestamp.localeCompare(left.timestamp)).slice(0, limit),
      logFiles: Object.entries(logs).map(([name, log]) => ({ name, path: log.path, size: log.size, loadedBytes: log.loadedBytes, truncated: log.truncated, exists: log.exists })),
    };
  }

  private getPaths(workspaceDir = this.getWorkspaceDir()): { tools: string; contextUsage: string; contextTrace: string; tasks: string } {
    const root = join(resolve(workspaceDir), ".internal", "logs");
    return {
      tools: join(root, "tool-execution.jsonl"),
      contextUsage: join(root, "context-usage.jsonl"),
      contextTrace: join(root, "context-trace.jsonl"),
      tasks: join(root, "task-events.jsonl"),
    };
  }
}

export function formatObservationReportText(report: AgentObservationReport, view = "summary"): string {
  const summary = report.summary;
  const heading = [
    `Agent observability · ${view}`,
    `workspace: ${report.workspaceDir}`,
    `runs ${summary.runs} · model requests ${summary.modelRequests} · tools ${summary.toolCalls} · success ${summary.toolSuccessRate.toFixed(1)}% · errors ${summary.errors}`,
    `tokens ${summary.totalTokens.toLocaleString()} (input ${summary.inputTokens.toLocaleString()}, output ${summary.outputTokens.toLocaleString()}, cache read ${summary.cacheReadTokens.toLocaleString()})`,
    `latency model avg ${formatDuration(summary.averageModelLatencyMs)} · tool avg ${formatDuration(summary.averageToolDurationMs)} · tool p95 ${formatDuration(summary.p95ToolDurationMs)} · active tasks ${summary.activeTasks}`,
  ];
  if (view === "runs") return [...heading, "", ...report.runs.slice(0, 20).map((run) => `${run.status.padEnd(9)} ${run.runId} · ${run.modelRequests} model · ${run.toolCalls} tools · ${run.errors} errors · ${formatDuration(run.durationMs ?? 0)}`)].join("\n");
  if (view === "tools") return [...heading, "", ...report.tools.slice(0, 30).map((tool) => `${tool.name.padEnd(28)} ${tool.calls} calls · ${tool.succeeded}/${tool.calls} ok · avg ${formatDuration(tool.averageDurationMs)} · p95 ${formatDuration(tool.p95DurationMs)}`)].join("\n");
  if (view === "errors") return [...heading, "", ...report.timeline.filter((item) => item.kind === "error").slice(0, 30).map(formatTimeline)].join("\n");
  if (view === "timeline") return [...heading, "", ...report.timeline.slice(0, 50).map(formatTimeline)].join("\n");
  return heading.join("\n");
}

function formatTimeline(item: ObservationTimelineItem): string {
  return `${item.timestamp} [${item.kind}] ${item.title}${item.status ? ` · ${item.status}` : ""}${item.durationMs !== undefined ? ` · ${formatDuration(item.durationMs)}` : ""}${item.detail ? `\n  ${item.detail.slice(0, 300)}` : ""}`;
}

function readJsonLog(path: string, maxBytes: number): { path: string; events: JsonRecord[]; size: number; loadedBytes: number; truncated: boolean; exists: boolean } {
  if (!existsSync(path)) return { path, events: [], size: 0, loadedBytes: 0, truncated: false, exists: false };
  let descriptor: number | undefined;
  try {
    const size = statSync(path).size;
    const bytesToRead = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    descriptor = openSync(path, "r");
    readSync(descriptor, buffer, 0, bytesToRead, Math.max(0, size - bytesToRead));
    const tail = buffer.toString("utf8");
    const lines = tail.split(/\r?\n/u);
    const truncated = size > maxBytes;
    if (truncated) lines.shift();
    const events = lines.flatMap((line) => {
      if (!line.trim()) return [];
      try { const value = JSON.parse(line) as unknown; return isRecord(value) ? [value] : []; } catch { return []; }
    });
    return { path, events, size, loadedBytes: bytesToRead, truncated, exists: true };
  } catch { return { path, events: [], size: 0, loadedBytes: 0, truncated: false, exists: true }; }
  finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Ignore a best-effort log read cleanup failure. */ }
    }
  }
}

function matchesRun(event: JsonRecord, runId?: string): boolean { return !runId || event.runId === runId; }
function observationId(prefix: string, event: JsonRecord): string { return `${prefix}-${readString(event.executionId) ?? readString(event.taskId) ?? readString(event.runId) ?? "event"}-${readString(event.timestamp) ?? ""}`; }
function readString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function readNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function readStringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function earlier(current: string | undefined, value: string): string { return !current || value < current ? value : current; }
function later(current: string | undefined, value: string): string { return !current || value > current ? value : current; }
function average(values: readonly number[]): number { return values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0; }
function percentile(values: readonly number[], quantile: number): number { if (values.length === 0) return 0; const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Math.floor(value))); }
function formatDuration(value: number): string { if (value < 1_000) return `${Math.round(value)} ms`; if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`; return `${(value / 60_000).toFixed(1)} min`; }
