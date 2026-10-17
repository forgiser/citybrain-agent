export interface WorkflowNode {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  dependencies: string[];
  inputPaths: string[];
  outputPaths: string[];
  cachePolicy: "never" | "by-input-fingerprint";
  maximumAttempts: number;
}

export interface WorkflowDefinition {
  id: string;
  version: 1;
  name: string;
  sourceRunId?: string;
  workspaceDir: string;
  createdAt: string;
  nodes: WorkflowNode[];
}

export interface WorkflowNodeState {
  nodeId: string;
  status: "running" | "completed" | "failed" | "cached";
  fingerprint: string;
  attempt: number;
  updatedAt: string;
  outputPaths: string[];
  outputFingerprint?: string;
  error?: string;
}

export interface WorkflowExecution {
  workflowId: string;
  startedAt: string;
  updatedAt: string;
  status: "running" | "completed" | "failed";
  nodes: Record<string, WorkflowNodeState>;
}
