import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCityBrainDir } from "../auth/auth-storage.js";
import type { ModelDefinition } from "./model-catalog.js";

interface StoredModelEntry {
  fetchedAt: string;
  models: ModelDefinition[];
}

type StoredModelData = Record<string, StoredModelEntry>;

export class ModelStore {
  private readonly path: string;

  constructor(path: string = join(getCityBrainDir(), "models-store.json")) {
    this.path = path;
  }

  getPath(): string {
    return this.path;
  }

  read(providerId: string): ModelDefinition[] {
    return this.load()[providerId]?.models ?? [];
  }

  write(providerId: string, models: ModelDefinition[]): void {
    const data = this.load();
    data[providerId] = {
      fetchedAt: new Date().toISOString(),
      models: models.map((model) => ({ ...model, source: "cache" })),
    };
    this.writeFile(data);
  }

  remove(providerId: string): void {
    const data = this.load();
    delete data[providerId];
    this.writeFile(data);
  }

  private load(): StoredModelData {
    if (!existsSync(this.path)) {
      return {};
    }

    const raw = readFileSync(this.path, "utf8").replace(/^\uFEFF/u, "");
    if (!raw.trim()) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isStoredModelData(parsed)) {
      throw new Error(`Invalid model store: ${this.path}`);
    }
    return parsed;
  }

  private writeFile(data: StoredModelData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function isStoredModelData(value: unknown): value is StoredModelData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const candidate = entry as Record<string, unknown>;
    return (
      typeof candidate.fetchedAt === "string" &&
      Array.isArray(candidate.models) &&
      candidate.models.every(isStoredModel)
    );
  });
}

function isStoredModel(value: unknown): value is ModelDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.provider === "string" &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    (candidate.contextWindow === undefined ||
      (typeof candidate.contextWindow === "number" && candidate.contextWindow > 0)) &&
    (candidate.source === "cache" || candidate.source === "provider_probe")
  );
}
