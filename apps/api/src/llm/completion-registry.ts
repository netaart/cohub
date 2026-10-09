import {
  mergeHeaders,
  mergeModelsConfigs,
  type ModelDef,
  type ModelsConfig,
  type ProviderConfig,
} from "@cohub/infra/config-runtime/models";
import type { Api, Model } from "@earendil-works/pi-ai";

export type RuntimeLlmModel = Model<Api> & {
  defaultThinkingLevel?: ModelDef["defaultThinkingLevel"];
  requestProfile?: ModelDef["requestProfile"];
  imageUrlInput?: boolean;
  /** Discovery hint: hidden models stay resolvable by id but never become implicit defaults. */
  hidden?: boolean;
};

function resolveApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const envValue = process.env[value];
  return envValue && envValue.trim().length > 0 ? envValue.trim() : value;
}

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

export class CompletionModelRegistry {
  private models: RuntimeLlmModel[] = [];
  private providerApiKeys = new Map<string, string>();

  constructor(configs: Array<ModelsConfig | null | undefined>) {
    const merged = mergeModelsConfigs(...configs.filter((item): item is ModelsConfig => Boolean(item)));
    const mergedModels = new Map<string, RuntimeLlmModel>();

    for (const [provider, providerConfig] of Object.entries(merged.providers ?? {})) {
      const apiKey = resolveApiKey((providerConfig as ProviderConfig).apiKey);
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
          hidden: modelDef.hidden === true,
        } as RuntimeLlmModel);
      }
    }

    this.models = [...mergedModels.values()];
  }

  /** Every configured model, including hidden ones, so explicit ids stay resolvable. */
  getAvailable() {
    return [...this.models];
  }

  /** Models eligible for implicit selection: defaults and provider fallbacks. */
  getDiscoverable() {
    return this.models.filter((model) => !model.hidden);
  }

  find(provider: string, id: string) {
    return this.models.find((model) => model.provider === provider && model.id === id);
  }

  getDefault() {
    return this.getDiscoverable()[0] ?? this.models[0];
  }

  getApiKey(provider: string) {
    return this.providerApiKeys.get(provider);
  }

  getHeaders(provider: string, modelId?: string) {
    return modelId ? this.find(provider, modelId)?.headers : undefined;
  }
}
