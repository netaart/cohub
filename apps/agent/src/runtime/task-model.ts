import type { ModelTaskConfig } from "@cohub/infra/config-runtime/model-tasks";
import { normalizeModelCost } from "@cohub/infra/config-runtime/models";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { createModelsFromRegistry } from "./pi-models-adapter.js";

export type TaskRuntimeModel = Model<Api> & Pick<ModelTaskConfig["model"], "requestProfile" | "imageUrlInput">;

export function toTaskRuntimeModel(
  config: ModelTaskConfig,
  defaults: { input: Array<"text" | "image">; contextWindow: number; maxTokens: number },
): TaskRuntimeModel {
  const model = config.model;
  return {
    id: model.id,
    name: model.name?.trim() || model.id,
    api: model.api as Api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning ?? false,
    input: model.input ?? defaults.input,
    cost: normalizeModelCost(model.cost),
    promptCache: model.promptCache,
    contextWindow: model.contextWindow ?? defaults.contextWindow,
    maxTokens: model.maxTokens ?? defaults.maxTokens,
    headers: model.headers,
    compat: model.compat as Model<Api>["compat"],
    requestProfile: model.requestProfile,
    imageUrlInput: model.imageUrlInput,
  };
}

/** Task models carry their own resolved credentials, outside the session registry. */
export function createTaskModels(config: ModelTaskConfig, model: Model<Api>): { models: Models; apiKey: string | undefined } {
  const apiKey = config.model.apiKey;
  const registry = {
    getAvailable: () => [model],
    getApiKey: (provider: string) => provider === model.provider ? apiKey : undefined,
    getHeaders: (provider: string, modelId?: string) =>
      provider === model.provider && (!modelId || modelId === model.id) ? model.headers : undefined,
  };
  return { models: createModelsFromRegistry(registry, model), apiKey };
}
