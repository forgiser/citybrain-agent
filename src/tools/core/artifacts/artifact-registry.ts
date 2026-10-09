import { resolve } from "node:path";

export type ArtifactStatus = "pending" | "ready" | "missing" | "invalid";

export interface ArtifactRecord {
  path: string;
  normalizedPath: string;
  producerTaskId: string;
  status: ArtifactStatus;
  registeredAt: string;
  readyAt?: string;
  error?: string;
}

export class ArtifactRegistry {
  private readonly records = new Map<string, ArtifactRecord>();
  private readonly waiters = new Map<
    string,
    Array<(record: ArtifactRecord) => void>
  >();

  registerPending(paths: string[], producerTaskId: string): ArtifactRecord[] {
    const registered: ArtifactRecord[] = [];
    for (const path of paths) {
      const normalizedPath = normalizeArtifactPath(path);
      if (!normalizedPath) continue;
      const record: ArtifactRecord = {
        path,
        normalizedPath,
        producerTaskId,
        status: "pending",
        registeredAt: new Date().toISOString(),
      };
      this.records.set(normalizedPath, record);
      registered.push(record);
    }
    return registered;
  }

  markReady(paths: string[]): ArtifactRecord[] {
    return this.update(paths, (record) => ({
      ...record,
      status: "ready",
      readyAt: new Date().toISOString(),
      error: undefined,
    }));
  }

  markMissing(paths: string[], error?: string): ArtifactRecord[] {
    return this.update(paths, (record) => ({
      ...record,
      status: "missing",
      error,
    }));
  }

  markInvalid(paths: string[], error?: string): ArtifactRecord[] {
    return this.update(paths, (record) => ({
      ...record,
      status: "invalid",
      error,
    }));
  }

  markProducerFailed(producerTaskId: string, error: string): ArtifactRecord[] {
    const paths = [...this.records.values()]
      .filter(
        (record) =>
          record.producerTaskId === producerTaskId &&
          record.status === "pending",
      )
      .map((record) => record.path);
    return this.markMissing(paths, error);
  }

  get(path: string): ArtifactRecord | undefined {
    return this.records.get(normalizeArtifactPath(path));
  }

  getPending(path: string): ArtifactRecord | undefined {
    const record = this.get(path);
    return record?.status === "pending" ? record : undefined;
  }

  async waitForTerminal(
    path: string,
    signal?: AbortSignal,
  ): Promise<ArtifactRecord | undefined> {
    const normalizedPath = normalizeArtifactPath(path);
    const current = this.records.get(normalizedPath);
    if (!current || current.status !== "pending") return current;

    return new Promise<ArtifactRecord>((resolvePromise, reject) => {
      const finish = (record: ArtifactRecord): void => {
        cleanup();
        resolvePromise(record);
      };
      const abort = (): void => {
        cleanup();
        reject(new Error("Artifact wait was cancelled."));
      };
      const cleanup = (): void => {
        const pending = this.waiters.get(normalizedPath);
        if (pending) {
          const index = pending.indexOf(finish);
          if (index >= 0) pending.splice(index, 1);
          if (pending.length === 0) this.waiters.delete(normalizedPath);
        }
        signal?.removeEventListener("abort", abort);
      };

      const pending = this.waiters.get(normalizedPath) ?? [];
      pending.push(finish);
      this.waiters.set(normalizedPath, pending);
      signal?.addEventListener("abort", abort, { once: true });

      const latest = this.records.get(normalizedPath);
      if (latest && latest.status !== "pending") finish(latest);
    });
  }

  snapshot(): ArtifactRecord[] {
    return [...this.records.values()];
  }

  private update(
    paths: string[],
    updater: (record: ArtifactRecord) => ArtifactRecord,
  ): ArtifactRecord[] {
    const updated: ArtifactRecord[] = [];
    for (const path of paths) {
      const normalizedPath = normalizeArtifactPath(path);
      const record = this.records.get(normalizedPath);
      if (!record) continue;
      const next = updater(record);
      this.records.set(normalizedPath, next);
      if (next.status !== "pending") {
        const waiters = this.waiters.get(normalizedPath) ?? [];
        this.waiters.delete(normalizedPath);
        for (const waiter of waiters) waiter(next);
      }
      updated.push(next);
    }
    return updated;
  }
}

export function normalizeArtifactPath(path: string): string {
  const value = path.trim().replace(/^["']|["']$/gu, "");
  if (!value) return "";
  return resolve(value).replace(/[\\/]+/gu, "\\").toLowerCase();
}
