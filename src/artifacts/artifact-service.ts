import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type {
  AgentArtifact,
  AgentArtifactKind,
  ArtifactEvent,
  InternalAgentArtifact,
  MapArtifactMetadata,
} from "./artifact-types.js";

export interface RegisterArtifactPathsInput {
  sessionId: string;
  runId?: string;
  producerTaskId?: string;
  paths: readonly string[];
}

export class ArtifactService {
  private readonly artifacts = new Map<string, InternalAgentArtifact>();
  private readonly pathIndex = new Map<string, string>();
  private readonly listeners = new Set<(event: ArtifactEvent) => void>();

  registerPaths(input: RegisterArtifactPathsInput): AgentArtifact[] {
    const registered: AgentArtifact[] = [];
    for (const rawPath of input.paths) {
      const path = resolve(rawPath);
      const key = `${input.sessionId}:${path.toLowerCase()}`;
      const existingId = this.pathIndex.get(key);
      if (existingId) {
        const existing = this.artifacts.get(existingId);
        if (existing) {
          registered.push(toPublic(existing));
          continue;
        }
      }

      const exists = existsSync(path);
      const stat = exists ? statSync(path) : undefined;
      const descriptor = describeArtifact(path);
      const id = `artifact-${createHash("sha256")
        .update(key)
        .digest("hex")
        .slice(0, 16)}`;
      const artifact: InternalAgentArtifact = {
        id,
        sessionId: input.sessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.producerTaskId
          ? { producerTaskId: input.producerTaskId }
          : {}),
        name: basename(path),
        path,
        kind: descriptor.kind,
        status: exists && stat?.isFile() ? "ready" : "missing",
        contentType: descriptor.contentType,
        ...(stat?.isFile() ? { sizeBytes: stat.size } : {}),
        createdAt: new Date().toISOString(),
        ...(exists && stat?.isFile()
          ? { contentUrl: `/api/artifacts/${id}/content` }
          : {}),
        ...(descriptor.map ? { map: descriptor.map } : {}),
      };
      if (artifact.map?.format === "geojson" && artifact.status === "ready") {
        artifact.map.dataUrl = `/api/artifacts/${id}/content`;
      }
      this.artifacts.set(id, artifact);
      this.pathIndex.set(key, id);
      const publicArtifact = toPublic(artifact);
      registered.push(publicArtifact);
      if (artifact.status === "ready") {
        this.emit({ type: "ready", artifact: publicArtifact });
      }
    }
    return registered;
  }

  get(id: string): AgentArtifact | undefined {
    const artifact = this.artifacts.get(id);
    return artifact ? toPublic(artifact) : undefined;
  }

  getInternal(id: string): InternalAgentArtifact | undefined {
    return this.artifacts.get(id);
  }

  list(sessionId?: string): AgentArtifact[] {
    return [...this.artifacts.values()]
      .filter((artifact) => !sessionId || artifact.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(toPublic);
  }

  subscribe(listener: (event: ArtifactEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  removeSession(sessionId: string): void {
    for (const [id, artifact] of this.artifacts) {
      if (artifact.sessionId !== sessionId) continue;
      this.artifacts.delete(id);
      this.pathIndex.delete(`${sessionId}:${artifact.path.toLowerCase()}`);
    }
  }

  private emit(event: ArtifactEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }
}

function describeArtifact(path: string): {
  kind: AgentArtifactKind;
  contentType: string;
  map?: MapArtifactMetadata;
} {
  const extension = extname(path).toLowerCase();
  if (extension === ".geojson") {
    return {
      kind: "vector",
      contentType: "application/geo+json; charset=utf-8",
      map: { format: "geojson", crs: "EPSG:4326" },
    };
  }
  if (extension === ".json") {
    return { kind: "report", contentType: "application/json; charset=utf-8" };
  }
  if ([".tif", ".tiff"].includes(extension)) {
    return {
      kind: "raster",
      contentType: "image/tiff",
      map: { format: "unsupported" },
    };
  }
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    const subtype = extension === ".jpg" ? "jpeg" : extension.slice(1);
    return {
      kind: "raster",
      contentType: `image/${subtype}`,
      map: { format: "image" },
    };
  }
  if ([".html", ".md", ".txt", ".csv"].includes(extension)) {
    return { kind: "report", contentType: "text/plain; charset=utf-8" };
  }
  return { kind: "file", contentType: "application/octet-stream" };
}

function toPublic(artifact: InternalAgentArtifact): AgentArtifact {
  const { path: _path, ...publicArtifact } = artifact;
  return structuredClone(publicArtifact);
}
