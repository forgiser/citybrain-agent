export type AgentHarnessState =
  | "idle"
  | "streaming_model"
  | "waiting_for_tools"
  | "executing_tools"
  | "finalizing"
  | "completed"
  | "failed"
  | "aborted";

export interface AgentHarnessStateUpdate {
  runId: string;
  turn: number;
  state: AgentHarnessState;
  previousState: AgentHarnessState;
  reason?: string;
}
