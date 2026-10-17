export type TaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "orphaned";

export type TaskTerminalStatus = Extract<
  TaskStatus,
  "completed" | "failed" | "cancelled" | "timed_out" | "orphaned"
>;

export type TaskCancellationKind = "cancelled" | "timed_out";

export interface TaskProgress {
  phase: string;
  message?: string;
  percent?: number;
  current?: number;
  total?: number;
  elapsedMs?: number;
  details?: Record<string, unknown>;
}

export interface TaskError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * Serializable view of a task. Runtime-only values such as the runner,
 * AbortController and listeners deliberately do not appear here.
 */
export interface TaskSnapshot<TResult = unknown> {
  id: string;
  name: string;
  description?: string;
  deduplicationKey?: string;
  idempotencyKey?: string;
  recoveryKey?: string;
  recoveryPayload?: Record<string, unknown>;
  attempt?: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  resourceKeys: string[];
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs?: number;
  progress?: TaskProgress;
  result?: TResult;
  error?: TaskError;
  cancellationReason?: string;
  artifactPaths: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskExecutionContext {
  taskId: string;
  signal: AbortSignal;
  reportProgress: (progress: TaskProgress) => void;
  addArtifacts: (paths: readonly string[]) => void;
  getSnapshot: () => TaskSnapshot;
}

export type TaskRunner<TResult = unknown> = (
  context: TaskExecutionContext,
) => Promise<TResult>;

export interface TaskSubmission<TResult = unknown> {
  name: string;
  description?: string;
  runner: TaskRunner<TResult>;
  /** Active tasks with the same key are reused instead of submitted twice. */
  deduplicationKey?: string;
  /** Repeated submissions with this key reuse the persisted task, including after restart. */
  idempotencyKey?: string;
  /** Only tasks with a registered recovery handler may be replayed after restart. */
  recoveryKey?: string;
  recoveryPayload?: Record<string, unknown>;
  /** Tasks sharing a resource key never run at the same time. */
  resourceKeys?: readonly string[];
  timeoutMs?: number;
  artifactPaths?: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface TaskListFilter {
  statuses?: readonly TaskStatus[];
  name?: string;
  workspaceDir?: string;
}

export interface TaskWaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type TaskEventType =
  | "submitted"
  | "started"
  | "progress"
  | "artifacts_changed"
  | "cancellation_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "orphaned"
  | "recovered"
  | "deleted";

export interface TaskEvent<TResult = unknown> {
  type: TaskEventType;
  task: TaskSnapshot<TResult>;
}

export type TaskEventListener = (event: TaskEvent) => void;

export function isTaskTerminal(
  status: TaskStatus,
): status is TaskTerminalStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out" ||
    status === "orphaned"
  );
}
