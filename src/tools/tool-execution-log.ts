import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_ARGUMENT_TEXT = 12_000;
const MAX_RESULT_TEXT = 12_000;
const MAX_DEPTH = 6;

export interface ToolExecutionLogContext {
  runId?: string;
  turn?: number;
  toolCallId?: string;
  taskId?: string;
}

export interface ToolExecutionLogEvent {
  schemaVersion: 1;
  timestamp: string;
  phase: "start" | "progress" | "artifact" | "finish";
  executionId: string;
  tool: string;
  runId?: string;
  turn?: number;
  toolCallId?: string;
  taskId?: string;
  argumentsText?: string;
  arguments?: unknown;
  ok?: boolean;
  status?: string;
  durationMs?: number;
  result?: string;
  error?: string;
  progress?: unknown;
  artifactPaths?: string[];
}

export interface HarnessStateLogEvent {
  schemaVersion: 1;
  timestamp: string;
  phase: "state";
  executionId: string;
  runId: string;
  turn: number;
  state: string;
  previousState: string;
  reason?: string;
}

export class ToolExecutionLogger {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly getLogPath: () => string) {}

  record(
    event: Omit<ToolExecutionLogEvent, "schemaVersion" | "timestamp">,
  ): Promise<void> {
    const line = `${JSON.stringify({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`;

    this.writeQueue = this.writeQueue
      .then(async () => {
        const path = this.getLogPath();
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line, "utf8");
      })
      .catch(() => undefined);

    return this.writeQueue;
  }

  static createStartEvent(
    executionId: string,
    tool: string,
    argumentsText: string,
    args: unknown,
    context?: ToolExecutionLogContext,
  ): Omit<ToolExecutionLogEvent, "schemaVersion" | "timestamp"> {
    return {
      phase: "start",
      executionId,
      tool,
      ...context,
      argumentsText: truncate(argumentsText, MAX_ARGUMENT_TEXT),
      arguments: sanitize(args),
    };
  }

  static createFinishEvent(
    executionId: string,
    tool: string,
    ok: boolean,
    durationMs: number,
    result: string,
    context?: ToolExecutionLogContext,
    status?: string,
  ): Omit<ToolExecutionLogEvent, "schemaVersion" | "timestamp"> {
    return {
      phase: "finish",
      executionId,
      tool,
      ...context,
      ok,
      ...(status ? { status } : {}),
      durationMs,
      ...(ok
        ? { result: truncate(result, MAX_RESULT_TEXT) }
        : { error: truncate(result, MAX_RESULT_TEXT) }),
    };
  }

  static createProgressEvent(
    executionId: string,
    tool: string,
    progress: unknown,
    context?: ToolExecutionLogContext,
  ): Omit<ToolExecutionLogEvent, "schemaVersion" | "timestamp"> {
    return {
      phase: "progress",
      executionId,
      tool,
      ...context,
      progress: sanitize(progress),
    };
  }

  static createArtifactEvent(
    executionId: string,
    tool: string,
    status: string,
    artifactPaths: string[],
    context?: ToolExecutionLogContext,
    error?: string,
  ): Omit<ToolExecutionLogEvent, "schemaVersion" | "timestamp"> {
    return {
      phase: "artifact",
      executionId,
      tool,
      ...context,
      status,
      artifactPaths: artifactPaths.slice(0, 100),
      ...(error ? { error: truncate(error, MAX_RESULT_TEXT) } : {}),
    };
  }

  recordHarnessState(
    runId: string,
    turn: number,
    state: string,
    previousState: string,
    reason?: string,
  ): Promise<void> {
    const line = `${JSON.stringify({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      phase: "state",
      executionId: `harness-${runId}-${turn}-${state}`,
      runId,
      turn,
      state,
      previousState,
      ...(reason ? { reason: truncate(reason, 2_000) } : {}),
    } satisfies HarnessStateLogEvent)}\n`;

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

function sanitize(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return "[max-depth]";
  if (typeof value === "string") return truncate(value, MAX_ARGUMENT_TEXT);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSensitiveKey(key)
        ? "[redacted]"
        : sanitize(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|authorization|password|secret|token)/iu.test(key);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[truncated at ${maxLength} characters]`;
}
