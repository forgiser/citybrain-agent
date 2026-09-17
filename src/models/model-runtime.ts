import { AuthStorage } from "../auth/auth-storage.js";
import { findProviderOption } from "../auth/providers.js";
import { findModel, getModelReference, type ModelDefinition } from "./model-catalog.js";
import { ModelSettings } from "./model-settings.js";
import { probeProviderModels, type ModelProbeOptions } from "./model-probe.js";
import { ModelStore } from "./model-store.js";

export interface ProviderRefreshResult {
  providerId: string;
  models: ModelDefinition[];
  error?: Error;
}

export class ModelRuntime {
  constructor(
    private readonly authStorage: AuthStorage,
    private readonly settings: ModelSettings = new ModelSettings(),
    private readonly modelStore: ModelStore = new ModelStore(),
    private readonly probe = probeProviderModels,
  ) {}

  getAvailableModels(): ModelDefinition[] {
    const loggedInProviders = new Set(this.authStorage.list());
    return [...loggedInProviders].flatMap((providerId) => this.modelStore.read(providerId));
  }

  getSelectedModel(): ModelDefinition | undefined {
    const selection = this.settings.getSelectedModel();
    if (!selection) {
      return undefined;
    }

    return findModel(
      this.getAvailableModels(),
      `${selection.provider}/${selection.model}`,
    );
  }

  getCredential(model?: ModelDefinition) {
    const selected = model ?? this.getSelectedModel();
    return selected ? this.authStorage.get(selected.provider) : undefined;
  }

  selectModel(model: ModelDefinition): void {
    this.settings.setSelectedModel({
      provider: model.provider,
      model: model.id,
    });
  }

  selectModelReference(reference: string): ModelDefinition {
    const model = findModel(this.getAvailableModels(), reference);
    if (!model) {
      throw new Error(`Model is not available: ${reference}`);
    }

    this.selectModel(model);
    return model;
  }

  ensureSelection(preferredProvider?: string): ModelDefinition | undefined {
    const current = this.getSelectedModel();
    if (current) {
      return current;
    }

    const available = this.getAvailableModels();
    const preferred = preferredProvider
      ? available.find((model) => model.provider === preferredProvider)
      : undefined;
    const next = preferred ?? available[0];
    if (next) {
      this.selectModel(next);
    }
    return next;
  }

  handleProviderLogout(providerId: string): ModelDefinition | undefined {
    const normalizedProviderId = providerId.trim().toLowerCase();
    const currentSelection = this.settings.getSelectedModel();
    if (currentSelection?.provider === normalizedProviderId) {
      this.settings.clearSelectedModel();
    }
    return this.ensureSelection();
  }

  async refreshProvider(
    providerId: string,
    options: ModelProbeOptions = {},
  ): Promise<ModelDefinition[]> {
    const normalizedProviderId = providerId.trim().toLowerCase();
    const credential = this.authStorage.get(normalizedProviderId);
    if (!credential) {
      throw new Error(`Provider is not logged in: ${normalizedProviderId}`);
    }

    const models = await this.probe(normalizedProviderId, credential, options);
    this.modelStore.write(normalizedProviderId, models);
    return this.modelStore.read(normalizedProviderId);
  }

  async refreshAll(options: ModelProbeOptions = {}): Promise<ProviderRefreshResult[]> {
    const providers = this.authStorage.list();
    return Promise.all(
      providers.map(async (providerId): Promise<ProviderRefreshResult> => {
        try {
          const models = await this.refreshProvider(providerId, options);
          return { providerId, models };
        } catch (error) {
          return {
            providerId,
            models: this.modelStore.read(providerId),
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      }),
    );
  }

  getModelStorePath(): string {
    return this.modelStore.getPath();
  }

  getProviderLabel(providerId: string): string {
    return findProviderOption(providerId)?.name ?? providerId;
  }

  getSettingsPath(): string {
    return this.settings.getPath();
  }
}
