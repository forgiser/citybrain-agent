import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskEvent, TaskSnapshot } from "./task-types.js";
import { cloneTaskSnapshot, type TaskStore } from "./task-store.js";

/** Durable snapshots and lifecycle events. The runner itself is never serialized. */
export class SqliteTaskStore implements TaskStore {
  private readonly database: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        workspace_dir TEXT,
        idempotency_key TEXT UNIQUE,
        updated_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_dir, updated_at);
      CREATE TABLE IF NOT EXISTS task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, sequence);
    `);
  }

  save(task: TaskSnapshot): void {
    const snapshot = cloneTaskSnapshot(task);
    const serialized = JSON.stringify(snapshot);
    if (!serialized) throw new Error(`Task ${task.id} is not serializable.`);
    this.database.prepare(`
      INSERT INTO tasks (id, status, workspace_dir, idempotency_key, updated_at, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        workspace_dir = excluded.workspace_dir,
        updated_at = excluded.updated_at,
        snapshot_json = excluded.snapshot_json
    `).run(
      task.id,
      task.status,
      typeof task.metadata?.workspaceDir === "string" ? task.metadata.workspaceDir : null,
      task.idempotencyKey ?? null,
      task.updatedAt,
      serialized,
    );
  }

  get(taskId: string): TaskSnapshot | undefined {
    const row = this.database.prepare("SELECT snapshot_json FROM tasks WHERE id = ?").get(taskId) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as TaskSnapshot : undefined;
  }

  getByIdempotencyKey(key: string): TaskSnapshot | undefined {
    const row = this.database.prepare("SELECT snapshot_json FROM tasks WHERE idempotency_key = ?").get(key) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as TaskSnapshot : undefined;
  }

  list(): TaskSnapshot[] {
    const rows = this.database.prepare("SELECT snapshot_json FROM tasks ORDER BY updated_at DESC").all() as Array<{ snapshot_json: string }>;
    return rows.map((row) => JSON.parse(row.snapshot_json) as TaskSnapshot);
  }

  delete(taskId: string): boolean {
    return this.database.prepare("DELETE FROM tasks WHERE id = ?").run(taskId).changes > 0;
  }

  recordEvent(event: TaskEvent): void {
    this.database.prepare("INSERT INTO task_events (task_id, event_type, timestamp, snapshot_json) VALUES (?, ?, ?, ?)")
      .run(event.task.id, event.type, new Date().toISOString(), JSON.stringify(event.task));
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.database.prepare("SELECT event_type, snapshot_json FROM task_events WHERE task_id = ? ORDER BY sequence").all(taskId) as Array<{ event_type: TaskEvent["type"]; snapshot_json: string }>;
    return rows.map((row) => ({ type: row.event_type, task: JSON.parse(row.snapshot_json) as TaskSnapshot }));
  }

  close(): void { this.database.close(); }
}
