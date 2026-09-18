import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ContextUsageSnapshot } from "./context-usage.js";

export interface ContextUsageLogEvent extends ContextUsageSnapshot {
  schemaVersion: 1;
  timestamp: string;
}

export class ContextUsageLogger {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly getLogPath: () => string) {}

  record(snapshot: ContextUsageSnapshot): Promise<void> {
    const line = `${JSON.stringify({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      ...snapshot,
    } satisfies ContextUsageLogEvent)}\n`;

    this.writeQueue = this.writeQueue
      .then(async () => {
        const path = this.getLogPath();
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line, "utf8");
      })
      .catch(() => undefined);

    return this.writeQueue;
  }
}
