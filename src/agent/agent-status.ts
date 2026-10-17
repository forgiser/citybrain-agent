import type { ModelUsage } from "../models/model-chat.js";

export type AgentStatus = "running" | "completed" | "failed";

/**
 * Live lifecycle of a delegated subagent, surfaced to the UI so it can render
 * a dedicated agent status line (name + token accounting + colored status)
 * instead of an opaque tool box. Lives in its own module so both agent-loop
 * (which emits these events) and tool-registry (through which a delegate tool
 * streams them up) can import it without a cycle.
 */
export interface AgentStatusUpdate {
  agent: string;
  status: AgentStatus;
  /** Cumulative usage for this subagent so far (may be absent until first API reply). */
  usage?: ModelUsage;
  error?: string;
}

/** UI/audit-safe child activity linked to the parent delegate tool call. */
export interface SubagentTraceStep {
  type: "text" | "thinking" | "tool_started" | "tool_result";
  delta?: string;
  name?: string;
  toolCallId?: string;
  argumentsText?: string;
  result?: string;
  ok?: boolean;
  status?: string;
  activityDescription?: string;
  toolUseSummary?: string;
}
