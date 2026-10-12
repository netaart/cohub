import type { Api, Model } from "@earendil-works/pi-ai";
import {
  mergeHeaders,
  mergeModelsConfigs,
  type ModelDef,
  type ModelRequestProfile,
  type ModelsConfig,
  type ModelThinkingLevel,
} from "@cohub/infra/config-runtime/models";

export type CohubModel<TApi extends Api = Api> = Model<TApi> & {
  defaultThinkingLevel?: ModelThinkingLevel;
  requestProfile?: ModelRequestProfile;
  imageUrlInput?: boolean;
};

function finiteNumberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeModelCost(cost: ModelDef["cost"] | undefined): Model<Api>["cost"] {
  return {
    input: finiteNumberOrZero(cost?.input),
    output: finiteNumberOrZero(cost?.output),
    cacheRead: finiteNumberOrZero(cost?.cacheRead),
    cacheWrite: finiteNumberOrZero(cost?.cacheWrite),
  };
}

export class CohubModelRegistry {
  private models: CohubModel[] = [];
  private providerApiKeys = new Map<string, string>();
  private loadError: string | undefined;
  private readonly configs: ModelsConfig[];

  constructor(input?: { configs?: Array<ModelsConfig | null | undefined> }) {
    this.configs = input?.configs?.filter((item): item is ModelsConfig => Boolean(item)) ?? [];
    this.refresh();
  }

  refresh(): void {
    this.models = [];
    this.providerApiKeys.clear();
    this.loadError = undefined;

    const mergedConfig = mergeModelsConfigs(...this.configs);
    const mergedModels = new Map<string, CohubModel>();

    for (const [provider, providerConfig] of Object.entries(mergedConfig.providers)) {
      const apiKey = providerConfig.apiKey;
      if (apiKey) this.providerApiKeys.set(provider, apiKey);

      for (const modelDef of providerConfig.models ?? []) {
        const api = modelDef.api ?? providerConfig.api;
        const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl;
        if (!api || !baseUrl || !modelDef.id) continue;
        mergedModels.set(`${provider}:${modelDef.id}`, {
          id: modelDef.id,
          name: modelDef.name ?? modelDef.id,
          api: api as Api,
          provider,
          baseUrl,
          reasoning: modelDef.reasoning ?? false,
          defaultThinkingLevel: modelDef.defaultThinkingLevel,
          thinkingLevelMap: modelDef.thinkingLevelMap,
          input: modelDef.input ?? ["text"],
          cost: normalizeModelCost(modelDef.cost),
          contextWindow: modelDef.contextWindow ?? 128000,
          maxTokens: modelDef.maxTokens ?? 16384,
          requestProfile: modelDef.requestProfile ?? providerConfig.requestProfile,
          imageUrlInput: modelDef.imageUrlInput ?? providerConfig.imageUrlInput,
          headers: mergeHeaders(providerConfig.headers, modelDef.headers),
          compat: (modelDef.compat ?? providerConfig.compat) as Model<Api>["compat"],
        } as CohubModel);
      }
    }

    this.models = [...mergedModels.values()];
  }

  getAvailable(): CohubModel[] {
    return [...this.models];
  }

  find(provider: string, id: string): CohubModel | undefined {
    return this.models.find((model) => model.provider === provider && model.id === id);
  }

  getDefault(): CohubModel | undefined {
    return this.models[0];
  }

  getError(): string | undefined {
    return this.loadError;
  }

  getApiKey(provider: string): string | undefined {
    return this.providerApiKeys.get(provider);
  }

  getHeaders(provider: string, modelId?: string): Record<string, string> | undefined {
    return modelId ? this.find(provider, modelId)?.headers : undefined;
  }
}
