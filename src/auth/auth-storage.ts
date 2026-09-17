import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

type AuthStorageData = Record<string, ApiKeyCredential>;

export function getCityBrainDir(): string {
  return process.env.CITYBRAIN_AGENT_DIR?.trim() || join(homedir(), ".citybrain");
}

export function getAuthPath(): string {
  return join(getCityBrainDir(), "auth.json");
}

export class AuthStorage {
  private readonly authPath: string;

  constructor(authPath: string = getAuthPath()) {
    this.authPath = authPath;
  }

  getPath(): string {
    return this.authPath;
  }

  get(providerId: string): ApiKeyCredential | undefined {
    return this.load()[providerId];
  }

  list(): string[] {
    return Object.keys(this.load()).sort();
  }

  setApiKey(providerId: string, key: string): void {
    const normalizedProviderId = providerId.trim().toLowerCase();
    const normalizedKey = cleanApiKey(key);

    if (!normalizedProviderId) {
      throw new Error("Provider name is required.");
    }
    if (!normalizedKey) {
      throw new Error("API key must not be empty.");
    }

    const next = this.load();
    next[normalizedProviderId] = {
      type: "api_key",
      key: normalizedKey,
    };
    this.write(next);
  }

  remove(providerId: string): boolean {
    const normalizedProviderId = providerId.trim().toLowerCase();
    const next = this.load();
    if (!next[normalizedProviderId]) {
      return false;
    }

    delete next[normalizedProviderId];
    this.write(next);
    return true;
  }

  private load(): AuthStorageData {
    if (!existsSync(this.authPath)) {
      return {};
    }

    const raw = readFileSync(this.authPath, "utf8").replace(/^\uFEFF/u, "");
    if (!raw.trim()) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isAuthStorageData(parsed)) {
      throw new Error(`Invalid auth file: ${this.authPath}`);
    }

    let normalized = false;
    for (const credential of Object.values(parsed)) {
      const cleanKey = cleanApiKey(credential.key);
      if (cleanKey !== credential.key) {
        credential.key = cleanKey;
        normalized = true;
      }
    }
    if (normalized) {
      this.write(parsed);
    }

    return parsed;
  }

  private write(data: AuthStorageData): void {
    mkdirSync(dirname(this.authPath), { recursive: true });
    writeFileSync(this.authPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function isAuthStorageData(value: unknown): value is AuthStorageData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((credential) => {
    if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
      return false;
    }

    const candidate = credential as Record<string, unknown>;
    return candidate.type === "api_key" && typeof candidate.key === "string";
  });
}

function cleanApiKey(key: string): string {
  return key
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "")
    .replace(/\[(?:200|201)~/gu, "")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim();
}
