import type { AgentEvent } from "../agent/agent-loop.js";
import type { TaskSnapshot } from "../task/index.js";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunSnapshot {
  id: string;
  sessionId: string;
  input: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

export type RuntimeEventType =
  | "run.started"
  | "run.state_changed"
  | "run.completed"
  | "run.failed"
  | "message.text_delta"
  | "message.thinking_delta"
  | "agent.event"
  | `task.${string}`
  | `interaction.${string}`
  | "artifact.ready";

export interface RuntimeEventEnvelope<T = unknown> {
  version: 1;
  eventId: string;
  sequence: number;
  timestamp: string;
  sessionId: string;
  runId: string;
  type: RuntimeEventType;
  data: T;
}

export interface RunManagerHooks {
  onArtifactPaths?: (input: {
    sessionId: string;
    runId: string;
    producerTaskId?: string;
    paths: readonly string[];
  }) => void;
}

export interface AgentRuntimeEventData {
  event: AgentEvent;
}

export interface TaskRuntimeEventData {
  task: TaskSnapshot;
}

