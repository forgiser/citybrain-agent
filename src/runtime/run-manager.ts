import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../agent/agent-loop.js";
import type { HumanInteractionEvent } from "../harness/human-interaction.js";
import {
  type TaskEvent,
} from "../task/index.js";
import type { AgentRuntime } from "./agent-runtime.js";
import type {
  RunManagerHooks,
  RunSnapshot,
  RunStatus,
  RuntimeEventEnvelope,
  RuntimeEventType,
} from "./runtime-events.js";

interface ManagedRun {
  snapshot: RunSnapshot;
  events: RuntimeEventEnvelope[];
  listeners: Set<(event: RuntimeEventEnvelope) => void>;
  abortController: AbortController;
  nextSequence: number;
}

const MAX_EVENTS_PER_RUN = 2_000;

/** Owns AgentLoop generators independently from any HTTP or CLI connection. */
export class RunManager {
  private readonly runs = new Map<string, ManagedRun>();
  private readonly agentRunToRun = new Map<string, string>();
  private activeRunId: string | undefined;
  private readonly unsubscribeTask: () => void;
  private readonly unsubscribeHuman: () => void;
  private disposed = false;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly hooks: RunManagerHooks = {},
  ) {
    this.unsubscribeTask = runtime.taskManager.subscribe((event) => {
      this.handleTaskEvent(event);
    });
    this.unsubscribeHuman = runtime.humanInteractionBroker.subscribe((event) => {
      this.handleHumanInteractionEvent(event);
    });
  }

  start(input: string): RunSnapshot {
    this.assertActive();
    const message = input.trim();
    if (!message) throw new Error("Run input cannot be empty.");
    if (this.activeRunId) {
      const active = this.runs.get(this.activeRunId);
      if (active && !isTerminal(active.snapshot.status)) {
        throw new Error("Another Agent run is already active.");
      }
    }

    const now = new Date().toISOString();
    const run: ManagedRun = {
      snapshot: {
        id: `run-${randomUUID()}`,
        sessionId: this.runtime.getSession().getSessionId(),
        input: message,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      },
      events: [],
      listeners: new Set(),
      abortController: new AbortController(),
      nextSequence: 1,
    };
    this.runs.set(run.snapshot.id, run);
    this.activeRunId = run.snapshot.id;
    queueMicrotask(() => void this.execute(run));
    return cloneRun(run.snapshot);
  }

  get(runId: string): RunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? cloneRun(run.snapshot) : undefined;
  }

  list(sessionId?: string): RunSnapshot[] {
    return [...this.runs.values()]
      .map((run) => run.snapshot)
      .filter((run) => !sessionId || run.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneRun);
  }

  getEvents(runId: string, afterSequence = 0): RuntimeEventEnvelope[] {
    return (this.runs.get(runId)?.events ?? [])
      .filter((event) => event.sequence > afterSequence)
      .map((event) => structuredClone(event));
  }

  subscribe(
    runId: string,
    listener: (event: RuntimeEventEnvelope) => void,
  ): () => void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.snapshot.status)) return false;
    run.abortController.abort();
    this.updateStatus(run, "cancelled");
    return true;
  }

  hasActiveRun(): boolean {
    if (!this.activeRunId) return false;
    const run = this.runs.get(this.activeRunId);
    return Boolean(run && !isTerminal(run.snapshot.status));
  }

  /** Kept for host compatibility; task completion is consumed inside AgentLoop. */
  notifySessionActivated(): void {
    this.assertActive();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeTask();
    this.unsubscribeHuman();
    for (const run of this.runs.values()) {
      if (!isTerminal(run.snapshot.status)) run.abortController.abort();
      run.listeners.clear();
    }
  }

  private async execute(run: ManagedRun): Promise<void> {
    this.updateStatus(run, "running");
    this.publish(run, "run.started", { run: cloneRun(run.snapshot) });
    try {
      const stream = this.runtime.agentLoop.run(run.snapshot.input, {
        thinkingLevel: this.runtime.getThinkingLevel(),
        signal: run.abortController.signal,
      });
      let response = "";
      for await (const event of stream) {
        this.captureAgentRunId(run, event);
        if (event.type === "text") {
          response += event.delta;
          this.publish(run, "message.text_delta", { delta: event.delta });
        } else if (event.type === "thinking") {
          this.publish(run, "message.thinking_delta", { delta: event.delta });
        } else {
          this.publish(run, "agent.event", { event });
        }
        this.captureArtifacts(run, event);
      }
      if (!run.abortController.signal.aborted) {
        this.updateStatus(run, "completed");
        this.publish(run, "run.completed", { response });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (run.abortController.signal.aborted) {
        this.updateStatus(run, "cancelled", message);
      } else {
        this.updateStatus(run, "failed", message);
        this.publish(run, "run.failed", { error: message });
      }
    } finally {
      if (this.activeRunId === run.snapshot.id) this.activeRunId = undefined;
    }
  }

  private captureAgentRunId(run: ManagedRun, event: AgentEvent): void {
    if ("runId" in event && typeof event.runId === "string") {
      this.agentRunToRun.set(event.runId, run.snapshot.id);
    }
  }

  private captureArtifacts(run: ManagedRun, event: AgentEvent): void {
    if (event.type !== "tool_progress") return;
    const paths = event.progress.outputPaths ?? [];
    if (paths.length === 0) return;
    this.hooks.onArtifactPaths?.({
      sessionId: run.snapshot.sessionId,
      runId: run.snapshot.id,
      producerTaskId: event.taskId,
      paths,
    });
  }

  private handleTaskEvent(event: TaskEvent): void {
    const agentRunId = readString(event.task.metadata?.runId);
    const runId = agentRunId ? this.agentRunToRun.get(agentRunId) : undefined;
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) return;
    this.publish(run, `task.${event.type}`, { task: event.task });
    if (event.task.artifactPaths.length > 0) {
      this.hooks.onArtifactPaths?.({
        sessionId: run.snapshot.sessionId,
        runId: run.snapshot.id,
        producerTaskId: event.task.id,
        paths: event.task.artifactPaths,
      });
    }
  }

  private handleHumanInteractionEvent(event: HumanInteractionEvent): void {
    const agentRunId = event.request.runId;
    const runId = agentRunId ? this.agentRunToRun.get(agentRunId) : undefined;
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) return;
    this.publish(run, `interaction.${event.type}`, event);
    if (event.type === "created") {
      this.updateStatus(run, "waiting_for_human");
    } else if (!isTerminal(run.snapshot.status)) {
      this.updateStatus(run, "running");
    }
  }

  private updateStatus(run: ManagedRun, status: RunStatus, error?: string): void {
    run.snapshot.status = status;
    run.snapshot.updatedAt = new Date().toISOString();
    if (error) run.snapshot.error = error;
    if (isTerminal(status)) run.snapshot.completedAt = run.snapshot.updatedAt;
    this.publish(run, "run.state_changed", { run: cloneRun(run.snapshot) });
  }

  private publish(run: ManagedRun, type: RuntimeEventType, data: unknown): void {
    const envelope: RuntimeEventEnvelope = {
      version: 1,
      eventId: `${run.snapshot.id}:${run.nextSequence}`,
      sequence: run.nextSequence++,
      timestamp: new Date().toISOString(),
      sessionId: run.snapshot.sessionId,
      runId: run.snapshot.id,
      type,
      data,
    };
    run.events.push(envelope);
    if (run.events.length > MAX_EVENTS_PER_RUN) run.events.shift();
    for (const listener of run.listeners) listener(structuredClone(envelope));
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("RunManager has been disposed.");
  }
}

function cloneRun(run: RunSnapshot): RunSnapshot {
  return { ...run };
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

