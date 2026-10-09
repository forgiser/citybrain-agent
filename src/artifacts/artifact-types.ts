export type AgentArtifactKind = "file" | "vector" | "raster" | "report";

export interface MapArtifactMetadata {
  format: "geojson" | "image" | "unsupported";
  crs?: string;
  dataUrl?: string;
}

export interface AgentArtifact {
  id: string;
  sessionId: string;
  runId?: string;
  producerTaskId?: string;
  name: string;
  kind: AgentArtifactKind;
  status: "ready" | "missing" | "invalid";
  contentType: string;
  sizeBytes?: number;
  createdAt: string;
  contentUrl?: string;
  map?: MapArtifactMetadata;
}

export interface InternalAgentArtifact extends AgentArtifact {
  path: string;
}

export type ArtifactEvent = {
  type: "ready";
  artifact: AgentArtifact;
};
