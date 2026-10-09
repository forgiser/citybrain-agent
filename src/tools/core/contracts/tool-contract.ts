import type { ToolCallContext } from "./tool-context.js";
import type { ToolError, ToolExecutionOutcome } from "./tool-types.js";

export type ToolSource = "builtin" | "qgis" | "mcp" | "subagent" | "map";
export type ToolInterruptBehavior = "cancel" | "block";
export type PermissionDecisionAction = "allow" | "deny" | "ask";

export interface PermissionDecision {
  action: PermissionDecisionAction;
  source: "sandbox" | "policy" | "project_rules" | "user" | "hook" | "system";
  reason?: string;
  requiresConfirmation?: boolean;
}

export interface ToolHookResult {
  decision?: "continue" | "block" | "mark_review";
  updatedInput?: unknown;
  additionalContext?: string;
  preventContinuation?: boolean;
  stopReason?: string;
  audit?: Record<string, unknown>;
}

export interface ToolHooks<Input = unknown, Output = unknown> {
  beforeExecute?: (
    input: Input,
    context: ToolCallContext,
  ) => Promise<ToolHookResult>;
  afterExecute?: (
    result: ToolExecutionOutcome,
    context: ToolCallContext,
  ) => Promise<ToolHookResult>;
  onError?: (
    error: ToolError,
    context: ToolCallContext,
  ) => Promise<ToolHookResult>;
}

/**
 * Shared metadata and lifecycle capabilities used by the registry, executor,
 * CLI and execution log.
 */
export interface ToolMetadata<Input = unknown> {
  aliases?: readonly string[];
  source?: ToolSource;
  isReadOnly?: (input: Input) => boolean;
  isDestructive?: (input: Input) => boolean;
  isConcurrencySafe?: (input: Input) => boolean;
  interruptBehavior?: ToolInterruptBehavior;
  getPath?: (input: Input) => string | string[] | undefined;
  getReadPaths?: (input: Input) => string | string[] | undefined;
  getWritePaths?: (input: Input) => string | string[] | undefined;
  getActivityDescription?: (input: Partial<Input>) => string;
  getToolUseSummary?: (input: Partial<Input>) => string | null | undefined;
  maxResultSizeChars?: number;
  requiresUserInteraction?: (input: Input) => boolean;
  /** Allow StreamingToolExecutor to return a task id while execution continues. */
  supportsBackground?: boolean;
  /** Foreground grace period before an eligible call is returned as a task. */
  backgroundAfterMs?: number;
  authorize?: (
    input: Input,
    context: ToolCallContext,
  ) => Promise<PermissionDecision>;
  hooks?: ToolHooks<Input, unknown>;
}

export interface ResolvedToolMetadata {
  name: string;
  source: ToolSource;
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  interruptBehavior: ToolInterruptBehavior;
  paths?: string[];
  readPaths?: string[];
  writePaths?: string[];
  activityDescription?: string;
  toolUseSummary?: string;
  maxResultSizeChars?: number;
  requiresUserInteraction: boolean;
  supportsBackground: boolean;
  backgroundAfterMs?: number;
  authorize?: (
    input: unknown,
    context: ToolCallContext,
  ) => Promise<PermissionDecision>;
  hooks?: ToolHooks<unknown, unknown>;
}

export function resolveToolMetadata<Input>(
  name: string,
  input: Input,
  metadata: ToolMetadata<Input> | undefined,
): ResolvedToolMetadata {
  const paths = resolvePaths(metadata?.getPath, input);
  const readPaths = resolvePaths(metadata?.getReadPaths, input);
  const writePaths = resolvePaths(metadata?.getWritePaths, input);
  const partialInput = isRecord(input) ? input as Partial<Input> : input;

  return {
    name,
    source: metadata?.source ?? "builtin",
    readOnly: safeBoolean(metadata?.isReadOnly, input, false),
    destructive: safeBoolean(metadata?.isDestructive, input, false),
    concurrencySafe: safeBoolean(metadata?.isConcurrencySafe, input, false),
    interruptBehavior: metadata?.interruptBehavior ?? "block",
    ...(paths.length > 0 ? { paths } : {}),
  ...(readPaths.length > 0 ? { readPaths } : {}),
  ...(writePaths.length > 0 ? { writePaths } : {}),
    ...(metadata?.getActivityDescription
      ? { activityDescription: safeText(metadata.getActivityDescription, partialInput) }
      : {}),
    ...(metadata?.getToolUseSummary
      ? { toolUseSummary: safeText(metadata.getToolUseSummary, partialInput) }
      : {}),
    ...(metadata?.maxResultSizeChars !== undefined &&
    Number.isSafeInteger(metadata.maxResultSizeChars) &&
    metadata.maxResultSizeChars > 0
      ? { maxResultSizeChars: metadata.maxResultSizeChars }
      : {}),
    requiresUserInteraction: safeBoolean(
      metadata?.requiresUserInteraction,
      input,
      false,
    ),
    supportsBackground: metadata?.supportsBackground === true,
    ...(normalizePositiveInteger(metadata?.backgroundAfterMs) !== undefined
      ? { backgroundAfterMs: normalizePositiveInteger(metadata?.backgroundAfterMs) }
      : {}),
    ...(metadata?.authorize
      ? {
          authorize: (value: unknown, context: ToolCallContext) =>
            metadata.authorize!(value as Input, context),
        }
      : {}),
    ...(metadata?.hooks
      ? { hooks: metadata.hooks as ToolHooks<unknown, unknown> }
      : {}),
  };
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function resolvePaths<Input>(
  resolver: ((input: Input) => string | string[] | undefined) | undefined,
  input: Input,
): string[] {
  if (!resolver) return [];
  let value: string | string[] | undefined;
  try {
    value = resolver(input);
  } catch {
    return [];
  }
  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((path): path is string => typeof path === "string" && Boolean(path.trim()));
}

function safeBoolean<Input>(
  resolver: ((input: Input) => boolean) | undefined,
  input: Input,
  fallback: boolean,
): boolean {
  if (!resolver) return fallback;
  try {
    return Boolean(resolver(input));
  } catch {
    return fallback;
  }
}

function safeText<Input>(
  resolver: (
    input: Partial<Input>,
  ) => string | null | undefined,
  input: Partial<Input>,
): string | undefined {
  try {
    const value = resolver(input);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
