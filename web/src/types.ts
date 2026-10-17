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
  subagentTrace?: SubagentTrace;
}

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

export interface SubagentTrace {
  parentToolCallId: string;
  subagentType: string;
  label: string;
  status?: "running" | "completed" | "failed";
  steps: SubagentTraceStep[];
}

export interface SessionDetails extends SessionSummary {
  messages: Message[];
  subagentTraces?: SubagentTrace[];
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
  map?: {
    format: string;
    dataUrl?: string;
    crs?: string;
    coordinates?: [[number, number], [number, number], [number, number], [number, number]];
    terrain?: {
      tileUrl: string;
      encoding: "mapbox";
      tileSize: number;
      minZoom: number;
      maxZoom: number;
      bounds: [number, number, number, number];
      exaggeration: number;
    };
    scene3d?: {
      type: "model" | "tiles3d";
      format: "gltf" | "glb" | "obj" | "3dtiles";
      url: string;
      placement?: {
        longitude: number;
        latitude: number;
        altitude: number;
        scale: number;
        rotation: [number, number, number];
      };
      offset?: { east: number; up: number; south: number };
    };
  };
  layer?: {
    sourcePath: string;
    sourceFormat: string;
    sourceCrs?: string;
    displayCrs: string;
    cached: boolean;
    visible: boolean;
    opacity: number;
    order: number;
    style?: Record<string, unknown>;
  };
}

export interface PendingMapLayer {
  id: string;
  name: string;
  message: string;
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
  kind?: "permission" | "sandbox_access" | "destructive_confirmation" | "recovery_choice" | "clarification" | "choice" | "confirmation" | "provider_fallback";
  title: string;
  message: string;
  options: Array<{ id: string; label: string; description?: string; dangerous?: boolean; recommended?: boolean }>;
  defaultOption?: string;
  risk?: string;
}
