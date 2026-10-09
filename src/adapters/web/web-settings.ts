import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCityBrainDir } from "../../auth/auth-storage.js";
import { providerOptions } from "../../auth/providers.js";
import {
  clearConfiguredQgisRuntime,
  browseQgisRuntimeFiles,
  configureQgisRuntime,
  findQgisCandidates,
} from "../../integrations/qgis/qgis-runtime.js";
import type { ThinkingLevel } from "../../models/model-chat.js";
import type { AgentRuntime } from "../../runtime/index.js";

export interface WebSettings {
  thinkingLevel: ThinkingLevel;
  selectedModel?: string;
  autoFitNewLayers: boolean;
  baseMap: "osm" | "blank";
  theme: "dark" | "light";
}

const DEFAULT_SETTINGS: WebSettings = {
  thinkingLevel: "high",
  autoFitNewLayers: true,
  baseMap: "osm",
  theme: "dark",
};

export class WebSettingsService {
  private settings: WebSettings;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly path = join(getCityBrainDir(), "web-settings.json"),
  ) {
    this.settings = this.load();
    runtime.setThinkingLevel(this.settings.thinkingLevel);
    if (this.settings.selectedModel) {
      try {
        runtime.modelRuntime.selectModelReference(this.settings.selectedModel);
      } catch {
        // A previously selected model may no longer be available.
      }
    }
  }

  get(): WebSettings {
    const selected = this.runtime.modelRuntime.getSelectedModel();
    const { selectedModel: _storedSelection, ...base } = this.settings;
    return {
      ...base,
      thinkingLevel: this.runtime.getThinkingLevel(),
      ...(selected
        ? { selectedModel: `${selected.provider}/${selected.id}` }
        : {}),
    };
  }

  getOptions(): Record<string, unknown> {
    return {
      thinkingLevels: ["off", "high", "max"],
      models: this.runtime.modelRuntime.getAvailableModels().map((model) => ({
        reference: `${model.provider}/${model.id}`,
        id: model.id,
        provider: model.provider,
        name: model.name,
      })),
      qgis: this.runtime.getQgisRuntime(),
      providers: providerOptions.map((provider) => ({
        ...provider,
        configured: Boolean(this.runtime.authStorage.get(provider.id)),
        modelCount: this.runtime.modelRuntime.getAvailableModels()
          .filter((model) => model.provider === provider.id).length,
      })),
    };
  }

  async configureProvider(providerId: string, apiKey: string): Promise<Record<string, unknown>> {
    const previous = this.runtime.authStorage.get(providerId);
    this.runtime.authStorage.setApiKey(providerId, apiKey);
    let models;
    try {
      models = await this.runtime.modelRuntime.refreshProvider(providerId);
    } catch (error) {
      if (previous) this.runtime.authStorage.setApiKey(providerId, previous.key);
      else this.runtime.authStorage.remove(providerId);
      throw error;
    }
    this.runtime.modelRuntime.ensureSelection(providerId);
    this.persistCurrentSelection();
    return { configured: true, providerId, modelCount: models.length, settings: this.get(), options: this.getOptions() };
  }

  async refreshProvider(providerId: string): Promise<Record<string, unknown>> {
    const models = await this.runtime.modelRuntime.refreshProvider(providerId);
    this.runtime.modelRuntime.ensureSelection(providerId);
    this.persistCurrentSelection();
    return { providerId, modelCount: models.length, settings: this.get(), options: this.getOptions() };
  }

  removeProvider(providerId: string): Record<string, unknown> {
    const removed = this.runtime.authStorage.remove(providerId);
    this.runtime.modelRuntime.handleProviderLogout(providerId);
    this.persistCurrentSelection();
    return { removed, settings: this.get(), options: this.getOptions() };
  }

  async configureQgis(path: string): Promise<Record<string, unknown>> {
    const qgis = await configureQgisRuntime(path);
    this.runtime.setQgisRuntime(qgis);
    return { qgis, options: this.getOptions() };
  }

  clearQgis(): Record<string, unknown> {
    clearConfiguredQgisRuntime();
    this.runtime.setQgisRuntime(undefined);
    return { cleared: true, options: this.getOptions() };
  }

  async getQgisCandidates(): Promise<string[]> {
    return findQgisCandidates();
  }

  browseQgisFiles(path?: string) {
    return browseQgisRuntimeFiles(path);
  }

  update(input: unknown): WebSettings {
    if (!isRecord(input)) throw new Error("Settings payload must be an object.");
    const next = { ...this.settings };
    if (input.thinkingLevel !== undefined) {
      if (!isThinkingLevel(input.thinkingLevel)) {
        throw new Error("thinkingLevel must be off, high, or max.");
      }
      next.thinkingLevel = input.thinkingLevel;
      this.runtime.setThinkingLevel(input.thinkingLevel);
    }
    if (input.selectedModel !== undefined) {
      if (typeof input.selectedModel !== "string" || !input.selectedModel.trim()) {
        throw new Error("selectedModel must be a non-empty model reference.");
      }
      const model = this.runtime.modelRuntime.selectModelReference(
        input.selectedModel.trim(),
      );
      next.selectedModel = `${model.provider}/${model.id}`;
    }
    if (input.autoFitNewLayers !== undefined) {
      if (typeof input.autoFitNewLayers !== "boolean") {
        throw new Error("autoFitNewLayers must be boolean.");
      }
      next.autoFitNewLayers = input.autoFitNewLayers;
    }
    if (input.baseMap !== undefined) {
      if (input.baseMap !== "osm" && input.baseMap !== "blank") {
        throw new Error("baseMap must be osm or blank.");
      }
      next.baseMap = input.baseMap;
    }
    if (input.theme !== undefined) {
      if (input.theme !== "dark" && input.theme !== "light") {
        throw new Error("theme must be dark or light.");
      }
      next.theme = input.theme;
    }
    this.settings = next;
    this.persist();
    return this.get();
  }

  private persistCurrentSelection(): void {
    const selected = this.runtime.modelRuntime.getSelectedModel();
    if (selected) this.settings.selectedModel = `${selected.provider}/${selected.id}`;
    else delete this.settings.selectedModel;
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
  }

  private load(): WebSettings {
    if (!existsSync(this.path)) return { ...DEFAULT_SETTINGS };
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!isRecord(value)) return { ...DEFAULT_SETTINGS };
      return {
        ...DEFAULT_SETTINGS,
        ...(isThinkingLevel(value.thinkingLevel)
          ? { thinkingLevel: value.thinkingLevel }
          : {}),
        ...(typeof value.selectedModel === "string"
          ? { selectedModel: value.selectedModel }
          : {}),
        ...(typeof value.autoFitNewLayers === "boolean"
          ? { autoFitNewLayers: value.autoFitNewLayers }
          : {}),
        ...(value.baseMap === "osm" || value.baseMap === "blank"
          ? { baseMap: value.baseMap }
          : {}),
        ...(value.theme === "dark" || value.theme === "light"
          ? { theme: value.theme }
          : {}),
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "high" || value === "max";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
