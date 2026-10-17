import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResolvedToolMetadata } from "../contracts/tool-contract.js";
import type { HumanInteractionEvent } from "../../../harness/human-interaction.js";

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
  phase: "start" | "progress" | "artifact" | "lifecycle" | "finish";
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
  toolSource?: string;
  readOnly?: boolean;
  destructive?: boolean;
  concurrencySafe?: boolean;
  interruptBehavior?: "cancel" | "block";
  toolPaths?: string[];
  toolUseSummary?: string;
  resultTruncated?: boolean;
  stage?: string;
  detail?: string;
  decisionAction?: "allow" | "deny" | "ask";
  decisionSource?: string;
  audit?: Record<string, unknown>;
  errorCode?: string;
  errorCategory?: string;
  errorLayer?: string;
  errorScope?: string;
  recovery?: string;
  humanRequestId?: string;
  humanKind?: string;
  humanDecision?: string;
  humanSource?: string;
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

  flush(): Promise<void> { return this.writeQueue; }

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
    metadata?: ResolvedToolMetadata,
  ): Omit<ToolExecutionLogEvent, "schemaVersion" | "timestamp"> {
    return {
      phase: "start",
      executionId,
      tool,
      ...context,
      argumentsText: truncate(argumentsText, MAX_ARGUMENT_TEXT),
      arguments: sanitize(args),
      ...(metadata
        ? {
            toolSource: metadata.source,
            readOnly: metadata.readOnly,
            destructive: metadata.destructive,
            concurrencySafe: metadata.concurrencySafe,
            interruptBehavior: metadata.interruptBehavior,
            ...(metadata.paths ? { toolPaths: metadata.paths } : {}),
            ...(metadata.toolUseSummary
              ? { toolUseSummary: truncate(metadata.toolUseSummary, 2_000) }
              : {}),
          }
        : {}),
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
    resultTruncated = false,
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
      ...(resultTruncated ? { resultTruncated: true } : {}),
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

  static createLifecycleEvent(
    executionId: string,
    tool: string,
    stage: string,
    context?: ToolExecutionLogContext,
    ok = true,
    detail?: string,
    decision?: {
      action: "allow" | "deny" | "ask";
      source: string;
    },
    audit?: Record<string, unknown>,
  ): Omit<ToolExecutionLogEvent, "schemaVersion" | "timestamp"> {
    return {
      phase: "lifecycle",
      executionId,
      tool,
      ...context,
      stage,
      ok,
      ...(detail ? { detail: truncate(detail, 4_000) } : {}),
      ...(decision
        ? {
            decisionAction: decision.action,
            decisionSource: decision.source,
          }
        : {}),
      ...(audit ? { audit: sanitize(audit) as Record<string, unknown> } : {}),
    };
  }

  static createHarnessErrorEvent(
    executionId: string,
    tool: string,
    error: {
      code: string;
      category: string;
      layer: string;
      scope: string;
      recovery: string;
      message: string;
    },
    context?: ToolExecutionLogContext,
  ): Omit<ToolExecutionLogEvent, "schemaVersion" | "timestamp"> {
    return {
      phase: "lifecycle",
      executionId,
      tool,
      ...context,
      stage: "harness_error",
      ok: false,
      detail: truncate(error.message, 4_000),
      errorCode: error.code,
      errorCategory: error.category,
      errorLayer: error.layer,
      errorScope: error.scope,
      recovery: error.recovery,
    };
  }

  static createHumanInteractionEvent(
    event: HumanInteractionEvent,
  ): Omit<ToolExecutionLogEvent, "schemaVersion" | "timestamp"> {
    const request = event.request;
    const decision = "decision" in event ? event.decision : undefined;
    return {
      phase: "lifecycle",
      executionId: request.requestId,
      tool: `human:${request.kind}`,
      runId: request.runId,
      turn: request.turn,
      stage: `human_${event.type}`,
      ok: event.type === "created" || event.type === "resolved",
      detail: truncate(
        decision?.reason ?? request.message,
        MAX_RESULT_TEXT,
      ),
      humanRequestId: request.requestId,
      humanKind: request.kind,
      ...(decision
        ? {
            humanDecision: decision.optionId ?? decision.action,
            humanSource: decision.source,
          }
        : {}),
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
