export type HarnessLayer =
  | "interaction"
  | "agent_loop"
  | "model_api"
  | "tool"
  | "runtime"
  | "persistence"
  | "observability";

export type HarnessScope =
  | "operation"
  | "tool"
  | "turn"
  | "run"
  | "session"
  | "workspace";

export type HarnessRecovery =
  | "repair_input"
  | "retry"
  | "wait"
  | "requery"
  | "ask_user"
  | "fallback"
  | "finalize"
  | "abort";

export type HarnessSideEffect = "none" | "partial" | "complete" | "unknown";

export type HarnessErrorCategory =
  | "invalid_input"
  | "permission_denied"
  | "sandbox_violation"
  | "runtime_failure"
  | "timeout"
  | "artifact_invalid"
  | "context_failure"
  | "persistence_failure"
  | "provider_failure"
  | "invariant_violation"
  | "cancelled"
  | "unknown";

export interface HarnessError {
  code: string;
  category: HarnessErrorCategory;
  layer: HarnessLayer;
  phase: string;
  scope: HarnessScope;
  message: string;
  retryable: boolean;
  recovery: HarnessRecovery;
  sideEffect: HarnessSideEffect;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export type HarnessState =
  | "idle"
  | "planning"
  | "executing"
  | "recovering"
  | "waiting_for_human"
  | "resuming"
  | "finalizing"
  | "completed"
  | "failed"
  | "aborted";

export interface HarnessStateUpdate {
  runId: string;
  turn: number;
  state: HarnessState;
  previousState: HarnessState;
  reason?: string;
  error?: HarnessError;
}

export interface HarnessErrorEvent {
  runId: string;
  turn: number;
  error: HarnessError;
}

export interface HarnessRecoveryDecision {
  action: HarnessRecovery;
  reason: string;
  delayMs?: number;
  maxAttempts?: number;
}

export type HarnessEvent =
  | ({ type: "state" } & HarnessStateUpdate)
  | ({ type: "error" } & HarnessErrorEvent)
  | {
      type: "recovery";
      runId: string;
      turn: number;
      error: HarnessError;
      decision: HarnessRecoveryDecision;
    };
