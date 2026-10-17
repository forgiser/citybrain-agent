export type DatasetProfileKind = "vector" | "raster" | "table" | "document" | "model3d" | "tiles3d";

export interface DatasetFingerprint {
  size: number;
  mtimeMs: number;
}

export interface DatasetProfile {
  schemaVersion: 1;
  id: string;
  sourcePath: string;
  relativePath: string;
  name: string;
  extension: string;
  kind: DatasetProfileKind;
  fingerprint: DatasetFingerprint;
  profiledAt: string;
  profiler: string;
  summary: string;
  details: Record<string, unknown>;
  warnings: string[];
}

export interface ProfileIndexEntry {
  id: string;
  sourcePath: string;
  relativePath: string;
  name: string;
  kind: DatasetProfileKind;
  fingerprint: DatasetFingerprint;
  profilePath: string;
  profiledAt: string;
  summary: string;
  warnings: string[];
}

export interface WorkspaceProfileIndex {
  schemaVersion: 1;
  revision: number;
  projectDir: string;
  workspaceDir: string;
  updatedAt: string;
  lastReconciledAt?: string;
  datasets: ProfileIndexEntry[];
}

export type ProfileJobStatus = "queued" | "running" | "completed" | "failed";

export interface WorkspaceProfileJob {
  schemaVersion: 1;
  id: string;
  status: ProfileJobStatus;
  projectDir: string;
  workspaceDir: string;
  sessionId?: string;
  runId?: string;
  changedPaths: string[];
  reconcile: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: { profiled: number; reused: number; removed: number; skipped: number };
}
