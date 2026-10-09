export interface SessionSummary {
  id: string;
  title: string;
  projectDir: string;
  workspaceDir: string;
  createdAt: string;
  modifiedAt: number;
  messageCount: number;
}

export interface Message {
  id?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  timestamp?: string;
  toolCallId?: string;
  toolName?: string;
  toolStatus?: "running" | "completed" | "failed" | "background";
  toolSummary?: string;
  toolArguments?: string;
}

export interface SessionDetails extends SessionSummary {
  messages: Message[];
}

export interface Artifact {
  id: string;
  sessionId: string;
  name: string;
  kind: string;
  status: string;
  contentUrl?: string;
  contentType?: string;
  size?: number;
  map?: { format: string; dataUrl?: string; crs?: string };
}

export interface TaskSnapshot {
  id: string;
  name: string;
  description?: string;
  status: string;
  progress?: { percent?: number; message?: string; phase?: string };
}

export interface RuntimeEnvelope {
  eventId: string;
  sequence: number;
  sessionId: string;
  runId: string;
  type: string;
  data: Record<string, unknown>;
}

export interface InteractionRequest {
  requestId: string;
  title: string;
  message: string;
  options: Array<{ id: string; label: string; description?: string; dangerous?: boolean }>;
  defaultOption?: string;
  risk?: string;
}
