import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCityBrainDir } from "../auth/auth-storage.js";

export interface StoredModelSelection {
  provider: string;
  model: string;
}

interface SettingsData {
  selectedModel?: StoredModelSelection;
}

export class ModelSettings {
  private readonly settingsPath: string;

  constructor(settingsPath: string = join(getCityBrainDir(), "settings.json")) {
    this.settingsPath = settingsPath;
  }

  getPath(): string {
    return this.settingsPath;
  }

  getSelectedModel(): StoredModelSelection | undefined {
    const data = this.load();
    return data.selectedModel;
  }

  setSelectedModel(selection: StoredModelSelection): void {
    const data = this.load();
    data.selectedModel = {
      provider: selection.provider.trim().toLowerCase(),
      model: selection.model.trim(),
    };
    this.write(data);
  }

  clearSelectedModel(): void {
    const data = this.load();
    delete data.selectedModel;
    this.write(data);
  }

  private load(): SettingsData {
    if (!existsSync(this.settingsPath)) {
      return {};
    }

    const raw = readFileSync(this.settingsPath, "utf8").replace(/^\uFEFF/u, "");
    if (!raw.trim()) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isSettingsData(parsed)) {
      throw new Error(`Invalid settings file: ${this.settingsPath}`);
    }
    return parsed;
  }

  private write(data: SettingsData): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function isSettingsData(value: unknown): value is SettingsData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const selectedModel = (value as Record<string, unknown>).selectedModel;
  if (selectedModel === undefined) {
    return true;
  }
  if (typeof selectedModel !== "object" || selectedModel === null || Array.isArray(selectedModel)) {
    return false;
  }

  const selection = selectedModel as Record<string, unknown>;
  return typeof selection.provider === "string" && typeof selection.model === "string";
}
