import type { AgentStatusUpdate } from "../../../agent/agent-status.js";
import type { SandboxPolicy } from "../../../workspace/sandbox-policy.js";
import type { ArtifactRecord, ArtifactRegistry } from "../artifacts/artifact-registry.js";
import type { FileReadSnapshot } from "../shared/file-write-utils.js";
import type { ResolvedToolMetadata } from "./tool-contract.js";
import type { ToolLifecycleEvent, ToolProgress } from "./tool-types.js";

/** Runtime capabilities and correlation data passed to one tool invocation. */
export interface ToolCallContext {
  emitAgentStatus?: (update: AgentStatusUpdate) => void;
  runId?: string;
  turn?: number;
  toolCallId?: string;
  taskId?: string;
  signal?: AbortSignal;
  artifacts?: ArtifactRegistry;
  emitProgress?: (progress: ToolProgress) => void;
  emitLifecycle?: (event: ToolLifecycleEvent) => void;
  queued?: boolean;
  registerArtifacts?: (paths: string[]) => ArtifactRecord[];
  markArtifactsReady?: (paths: string[]) => ArtifactRecord[];
  markArtifactsMissing?: (paths: string[], error?: string) => ArtifactRecord[];
  sandbox?: SandboxPolicy;
  recordFileRead?: (snapshot: FileReadSnapshot) => void;
  getFileReadSnapshot?: (path: string) => FileReadSnapshot | undefined;
  toolName?: string;
  toolMetadata?: ResolvedToolMetadata;
}
