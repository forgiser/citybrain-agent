import type { TaskSnapshot } from "./task-types.js";

/**
 * Persistence boundary for task snapshots. The first implementation is
 * intentionally in-memory; a JSONL/SQLite store can replace it later without
 * changing TaskManager or StreamingToolExecutor integration code.
 */
export interface TaskStore {
  save(task: TaskSnapshot): void;
  get(taskId: string): TaskSnapshot | undefined;
  list(): TaskSnapshot[];
  delete(taskId: string): boolean;
}

export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskSnapshot>();

  save(task: TaskSnapshot): void {
    this.tasks.set(task.id, cloneTaskSnapshot(task));
  }

  get(taskId: string): TaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneTaskSnapshot(task) : undefined;
  }

  list(): TaskSnapshot[] {
    return [...this.tasks.values()].map(cloneTaskSnapshot);
  }

  delete(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }
}

export function cloneTaskSnapshot<TResult>(
  task: TaskSnapshot<TResult>,
): TaskSnapshot<TResult> {
  return {
    ...task,
    artifactPaths: [...task.artifactPaths],
    resourceKeys: [...task.resourceKeys],
    ...(task.progress
      ? {
          progress: {
            ...task.progress,
            ...(task.progress.details
              ? { details: { ...task.progress.details } }
              : {}),
          },
        }
      : {}),
    ...(task.error
      ? {
          error: {
            ...task.error,
            ...(task.error.details
              ? { details: { ...task.error.details } }
              : {}),
          },
        }
      : {}),
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
    ...(task.result !== undefined
      ? { result: cloneUnknown(task.result) as TResult }
      : {}),
  };
}

function cloneUnknown(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    // Task results are expected to be serializable. Keep the original value as
    // a compatibility fallback until a persistent store enforces that rule.
    return value;
  }
}
