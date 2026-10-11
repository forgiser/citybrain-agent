import { randomUUID } from "node:crypto";
import {
  isTaskTerminal,
  type TaskCancellationKind,
  type TaskError,
  type TaskEvent,
  type TaskEventListener,
  type TaskListFilter,
  type TaskProgress,
  type TaskRunner,
  type TaskSnapshot,
  type TaskStatus,
  type TaskSubmission,
  type TaskWaitOptions,
} from "./task-types.js";
import {
  cloneTaskSnapshot,
  InMemoryTaskStore,
  type TaskStore,
} from "./task-store.js";

export interface TaskManagerOptions {
  /** Maximum number of runners active at once. Defaults to one. */
  maxConcurrent?: number;
  /** Maximum queued tasks waiting for an execution slot. Defaults to 100. */
  maxQueued?: number;
  store?: TaskStore;
  createId?: () => string;
  now?: () => Date;
}

interface ManagedTask {
  snapshot: TaskSnapshot;
  runner: TaskRunner;
  controller: AbortController;
  cancellationKind?: TaskCancellationKind;
  timeout?: ReturnType<typeof setTimeout>;
}

interface TaskWaiter {
  resolve: (task: TaskSnapshot) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

/**
 * In-process background-task coordinator.
 *
 * It is deliberately independent from ToolRegistry and StreamingToolExecutor:
 * tool validation, permission and artifact preflight should happen before a
 * future integration submits a runner here.
 */
export class TaskManager {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly store: TaskStore;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly queue: string[] = [];
  private readonly listeners = new Set<TaskEventListener>();
  private readonly waiters = new Map<string, Set<TaskWaiter>>();
  private readonly activeDeduplicationKeys = new Map<string, string>();
  private readonly activeResourceKeys = new Set<string>();
  private running = 0;
  private drainScheduled = false;
  private disposed = false;

  constructor(options: TaskManagerOptions = {}) {
    this.maxConcurrent = normalizeMaxConcurrent(options.maxConcurrent);
    this.maxQueued = normalizeMaxQueued(options.maxQueued);
    this.store = options.store ?? new InMemoryTaskStore();
    this.createId = options.createId ?? (() => `task-${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  submit<TResult>(submission: TaskSubmission<TResult>): TaskSnapshot<TResult> {
    this.assertActive();
    const name = submission.name.trim();
    if (!name) throw new Error("Task name must not be empty.");
    if (typeof submission.runner !== "function") {
      throw new Error("Task runner must be a function.");
    }

    const deduplicationKey = submission.deduplicationKey?.trim();
    if (deduplicationKey) {
      const existingId = this.activeDeduplicationKeys.get(deduplicationKey);
      const existing = existingId ? this.get<TResult>(existingId) : undefined;
      if (existing && !isTaskTerminal(existing.status)) return existing;
      if (existingId) this.activeDeduplicationKeys.delete(deduplicationKey);
    }
    if (this.queue.length >= this.maxQueued) {
      throw new Error(`Task queue limit reached (${this.maxQueued}).`);
    }

    const id = this.createUniqueId();
    const timestamp = this.timestamp();
    const snapshot: TaskSnapshot<TResult> = {
      id,
      name,
      ...(submission.description?.trim()
        ? { description: submission.description.trim() }
        : {}),
      ...(deduplicationKey ? { deduplicationKey } : {}),
      resourceKeys: normalizeKeys(submission.resourceKeys ?? []),
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(normalizeTimeout(submission.timeoutMs) !== undefined
        ? { timeoutMs: normalizeTimeout(submission.timeoutMs) }
        : {}),
      artifactPaths: normalizePaths(submission.artifactPaths ?? []),
      ...(submission.metadata
        ? { metadata: { ...submission.metadata } }
        : {}),
    };
    const managed: ManagedTask = {
      snapshot: snapshot as TaskSnapshot,
      runner: submission.runner as TaskRunner,
      controller: new AbortController(),
    };
    this.tasks.set(id, managed);
    if (deduplicationKey) this.activeDeduplicationKeys.set(deduplicationKey, id);
    this.queue.push(id);
    this.persist(managed.snapshot);
    this.emit("submitted", managed.snapshot);
    this.scheduleDrain();
    return cloneTaskSnapshot(snapshot);
  }

  get<TResult = unknown>(taskId: string): TaskSnapshot<TResult> | undefined {
    const managed = this.tasks.get(taskId);
    const snapshot = managed?.snapshot ?? this.store.get(taskId);
    return snapshot
      ? cloneTaskSnapshot(snapshot) as TaskSnapshot<TResult>
      : undefined;
  }

  list<TResult = unknown>(filter: TaskListFilter = {}): TaskSnapshot<TResult>[] {
    const statuses = filter.statuses ? new Set(filter.statuses) : undefined;
    const name = filter.name?.trim().toLowerCase();
    return this.store
      .list()
      .filter((task) => !statuses || statuses.has(task.status))
      .filter((task) => !name || task.name.toLowerCase().includes(name))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((task) => cloneTaskSnapshot(task) as TaskSnapshot<TResult>);
  }

  wait<TResult = unknown>(
    taskId: string,
    options: TaskWaitOptions = {},
  ): Promise<TaskSnapshot<TResult>> {
    const task = this.get<TResult>(taskId);
    if (!task) {
      return Promise.reject(new TaskNotFoundError(taskId));
    }
    if (isTaskTerminal(task.status)) return Promise.resolve(task);
    if (options.signal?.aborted) {
      return Promise.reject(createAbortError(`Waiting for ${taskId} was cancelled.`));
    }

    return new Promise<TaskSnapshot<TResult>>((resolve, reject) => {
      const waiter: TaskWaiter = {
        resolve: (snapshot) => resolve(snapshot as TaskSnapshot<TResult>),
        reject,
      };
      const timeoutMs = normalizeTimeout(options.timeoutMs);
      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          this.removeWaiter(taskId, waiter);
          reject(new TaskWaitTimeoutError(taskId, timeoutMs));
        }, timeoutMs);
        waiter.timeout.unref?.();
      }
      if (options.signal) {
        waiter.signal = options.signal;
        waiter.abort = () => {
          this.removeWaiter(taskId, waiter);
          reject(createAbortError(`Waiting for ${taskId} was cancelled.`));
        };
        options.signal.addEventListener("abort", waiter.abort, { once: true });
      }
      const pending = this.waiters.get(taskId) ?? new Set<TaskWaiter>();
      pending.add(waiter);
      this.waiters.set(taskId, pending);
    });
  }

  cancel(taskId: string, reason = "task cancelled"): boolean {
    const task = this.tasks.get(taskId);
    if (!task || isTaskTerminal(task.snapshot.status)) return false;
    return this.requestCancellation(task, "cancelled", reason);
  }

  getActiveByDeduplicationKey<TResult = unknown>(
    key: string,
  ): TaskSnapshot<TResult> | undefined {
    const taskId = this.activeDeduplicationKeys.get(key.trim());
    return taskId ? this.get<TResult>(taskId) : undefined;
  }

  /** Update scheduler-owned metadata without changing task lifecycle state. */
  updateMetadata(taskId: string, values: Record<string, unknown>): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    this.update(task, {
      metadata: { ...(task.snapshot.metadata ?? {}), ...values },
      updatedAt: this.timestamp(),
    });
    return true;
  }

  delete(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    const snapshot = task?.snapshot ?? this.store.get(taskId);
    if (!snapshot) return false;
    if (!isTaskTerminal(snapshot.status)) {
      throw new TaskStateError(
        taskId,
        `Cannot delete a task in ${snapshot.status} state.`,
      );
    }
    this.tasks.delete(taskId);
    const deleted = this.store.delete(taskId);
    if (deleted) this.emit("deleted", snapshot);
    return deleted;
  }

  subscribe(listener: TaskEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cancel queued/running work and reject outstanding wait calls. */
  dispose(reason = "task manager disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const task of this.tasks.values()) {
      if (!isTaskTerminal(task.snapshot.status)) {
        this.requestCancellation(task, "cancelled", reason);
      }
    }
    for (const [taskId, waiters] of this.waiters) {
      for (const waiter of waiters) {
        this.cleanupWaiter(waiter);
        waiter.reject(createAbortError(`Waiting for ${taskId} was cancelled.`));
      }
    }
    this.waiters.clear();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.disposed) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (!this.disposed && this.running < this.maxConcurrent) {
      const position = this.queue.findIndex((taskId) => {
        const candidate = this.tasks.get(taskId);
        return Boolean(
          candidate &&
          candidate.snapshot.status === "queued" &&
          candidate.snapshot.resourceKeys.every(
            (key) => !this.activeResourceKeys.has(key),
          ),
        );
      });
      if (position < 0) return;
      const [taskId] = this.queue.splice(position, 1);
      if (!taskId) return;
      const task = this.tasks.get(taskId);
      if (!task || task.snapshot.status !== "queued") continue;
      this.running += 1;
      for (const key of task.snapshot.resourceKeys) {
        this.activeResourceKeys.add(key);
      }
      void this.execute(task).finally(() => {
        for (const key of task.snapshot.resourceKeys) {
          this.activeResourceKeys.delete(key);
        }
        this.running -= 1;
        this.scheduleDrain();
      });
    }
  }

  private async execute(task: ManagedTask): Promise<void> {
    const startedAt = this.timestamp();
    this.update(task, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
    });
    this.emit("started", task.snapshot);

    if (task.snapshot.timeoutMs !== undefined) {
      task.timeout = setTimeout(() => {
        this.requestCancellation(
          task,
          "timed_out",
          `task timed out after ${task.snapshot.timeoutMs}ms`,
        );
      }, task.snapshot.timeoutMs);
      task.timeout.unref?.();
    }

    try {
      const result = await task.runner({
        taskId: task.snapshot.id,
        signal: task.controller.signal,
        reportProgress: (progress) => this.reportProgress(task, progress),
        addArtifacts: (paths) => this.addArtifacts(task, paths),
        getSnapshot: () => cloneTaskSnapshot(task.snapshot),
      });
      if (task.cancellationKind) {
        this.finishCancellation(task);
      } else {
        this.finish(task, "completed", { result });
      }
    } catch (error) {
      if (task.cancellationKind) {
        this.finishCancellation(task, error);
      } else {
        this.finish(task, "failed", { error: normalizeTaskError(error) });
      }
    } finally {
      if (task.timeout) clearTimeout(task.timeout);
    }
  }

  private reportProgress(task: ManagedTask, progress: TaskProgress): void {
    if (isTaskTerminal(task.snapshot.status)) return;
    const normalized = normalizeProgress(progress);
    this.update(task, {
      progress: normalized,
      updatedAt: this.timestamp(),
    });
    this.emit("progress", task.snapshot);
  }

  private addArtifacts(task: ManagedTask, paths: readonly string[]): void {
    if (isTaskTerminal(task.snapshot.status)) return;
    const artifactPaths = normalizePaths([
      ...task.snapshot.artifactPaths,
      ...paths,
    ]);
    if (artifactPaths.length === task.snapshot.artifactPaths.length) return;
    this.update(task, { artifactPaths, updatedAt: this.timestamp() });
    this.emit("artifacts_changed", task.snapshot);
  }

  private requestCancellation(
    task: ManagedTask,
    kind: TaskCancellationKind,
    reason: string,
  ): boolean {
    if (isTaskTerminal(task.snapshot.status)) return false;
    task.cancellationKind = kind;
    this.update(task, {
      cancellationReason: reason,
      updatedAt: this.timestamp(),
    });
    if (task.snapshot.status === "queued") {
      const position = this.queue.indexOf(task.snapshot.id);
      if (position >= 0) this.queue.splice(position, 1);
      this.finishCancellation(task);
      return true;
    }
    this.update(task, {
      status: "cancelling",
      updatedAt: this.timestamp(),
    });
    task.controller.abort(reason);
    this.emit("cancellation_requested", task.snapshot);
    return true;
  }

  private finishCancellation(task: ManagedTask, error?: unknown): void {
    const status = task.cancellationKind ?? "cancelled";
    this.finish(task, status, {
      ...(error !== undefined ? { error: normalizeTaskError(error) } : {}),
    });
  }

  private finish(
    task: ManagedTask,
    status: "completed" | "failed" | "cancelled" | "timed_out",
    values: { result?: unknown; error?: TaskError },
  ): void {
    if (isTaskTerminal(task.snapshot.status)) return;
    const finishedAt = this.timestamp();
    this.update(task, {
      status,
      updatedAt: finishedAt,
      finishedAt,
      ...(values.result !== undefined ? { result: values.result } : {}),
      ...(values.error ? { error: values.error } : {}),
    });
    if (task.snapshot.deduplicationKey) {
      const activeId = this.activeDeduplicationKeys.get(
        task.snapshot.deduplicationKey,
      );
      if (activeId === task.snapshot.id) {
        this.activeDeduplicationKeys.delete(task.snapshot.deduplicationKey);
      }
    }
    this.emit(status, task.snapshot);
    this.resolveWaiters(task.snapshot);
  }

  private update(task: ManagedTask, values: Partial<TaskSnapshot>): void {
    task.snapshot = { ...task.snapshot, ...values };
    this.persist(task.snapshot);
  }

  private persist(snapshot: TaskSnapshot): void {
    this.store.save(snapshot);
  }

  private emit(type: TaskEvent["type"], snapshot: TaskSnapshot): void {
    const event: TaskEvent = {
      type,
      task: cloneTaskSnapshot(snapshot),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers must not be able to break task execution.
      }
    }
  }

  private resolveWaiters(snapshot: TaskSnapshot): void {
    const waiters = this.waiters.get(snapshot.id);
    if (!waiters) return;
    this.waiters.delete(snapshot.id);
    for (const waiter of waiters) {
      this.cleanupWaiter(waiter);
      waiter.resolve(cloneTaskSnapshot(snapshot));
    }
  }

  private removeWaiter(taskId: string, waiter: TaskWaiter): void {
    const waiters = this.waiters.get(taskId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.waiters.delete(taskId);
    this.cleanupWaiter(waiter);
  }

  private cleanupWaiter(waiter: TaskWaiter): void {
    if (waiter.timeout) clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
  }

  private createUniqueId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.createId().trim();
      if (id && !this.tasks.has(id) && !this.store.get(id)) return id;
    }
    throw new Error("Unable to allocate a unique task id.");
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("TaskManager has been disposed.");
  }
}

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Task does not exist: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskStateError extends Error {
  constructor(readonly taskId: string, message: string) {
    super(message);
    this.name = "TaskStateError";
  }
}

export class TaskWaitTimeoutError extends Error {
  constructor(readonly taskId: string, readonly timeoutMs: number) {
    super(`Timed out waiting for task ${taskId} after ${timeoutMs}ms.`);
    this.name = "TaskWaitTimeoutError";
  }
}

function normalizeMaxConcurrent(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("maxConcurrent must be a positive safe integer.");
  }
  return value;
}

function normalizeMaxQueued(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("maxQueued must be a positive safe integer.");
  }
  return value;
}

function normalizeTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("timeoutMs must be a positive finite number.");
  }
  return Math.floor(value);
}

function normalizeProgress(progress: TaskProgress): TaskProgress {
  const percent = progress.percent === undefined
    ? undefined
    : Math.min(100, Math.max(0, progress.percent));
  return {
    ...progress,
    phase: progress.phase.trim() || "running",
    ...(percent !== undefined ? { percent } : {}),
    ...(progress.details ? { details: { ...progress.details } } : {}),
  };
}

function normalizePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

function normalizeKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key.trim().toLowerCase()).filter(Boolean))];
}

function normalizeTaskError(error: unknown): TaskError {
  if (error instanceof Error) {
    const value = error as Error & { code?: unknown; details?: unknown };
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      ...(isRecord(value.details) ? { details: { ...value.details } } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
