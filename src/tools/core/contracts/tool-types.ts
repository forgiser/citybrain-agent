import type { AgentStatusUpdate } from "../../../agent/agent-status.js";
import type { HarnessError } from "../../../harness/index.js";
import type { ArtifactRecord } from "../artifacts/artifact-registry.js";
import type { FileReadSnapshot } from "../shared/file-write-utils.js";
import type { ResolvedToolMetadata } from "./tool-contract.js";
import type { ToolCallContext } from "./tool-context.js";

export type ToolTaskStatus = "background" | "completed" | "failed";

export interface ToolError {
  code:
    | "unknown_tool"
    | "invalid_json"
    | "invalid_input"
    | "policy_denied"
    | "permission_denied"
    | "execution_failed"
    | "output_invalid"
    | "cancelled"
    | "timeout";
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ToolLifecycleStage =
  | "tool_resolved"
  | "tool_validating"
  | "tool_normalizing"
  | "tool_normalized"
  | "pre_tool_hook"
  | "sandbox_check"
  | "policy_check"
  | "permission_decision"
  | "tool_artifact_preflight"
  | "tool_queued"
  | "tool_started"
  | "tool_completed"
  | "post_tool_hook"
  | "failure_hook"
  | "tool_failed";

export interface ToolLifecycleEvent {
  taskId?: string;
  stage: ToolLifecycleStage;
  ok: boolean;
  detail?: string;
}

export interface ToolProgress {
  taskId?: string;
  phase: "starting" | "running" | "verifying_outputs" | "completed" | "failed";
  elapsedMs?: number;
  message?: string;
  stdoutTail?: string;
  stderrTail?: string;
  outputPaths?: string[];
  missingOutputPaths?: string[];
}

export interface ToolExecutionOutcome {
  ok: boolean;
  content: string;
  taskId: string;
  status: ToolTaskStatus;
  preventContinuation?: boolean;
  hookContext?: string[];
  harnessError?: HarnessError;
}

export type ToolHandler = (
  args: unknown,
  context?: ToolCallContext,
) => Promise<string>;

export type ToolAgentStatusEmitter = (update: AgentStatusUpdate) => void;

export type ToolFileReadRecorder = (snapshot: FileReadSnapshot) => void;

export type ToolMetadataResolver = (
  input: unknown,
  context: ToolCallContext,
) => ResolvedToolMetadata;

export type ToolArtifactRegistrar = (
  paths: string[],
) => ArtifactRecord[];
