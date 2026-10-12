import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type ProviderStreams,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { withImageInputs, type ImageInputOptions } from "./image-content.js";
import { withRequestProfiles } from "./request-profile/index.js";

/** Auth + catalog surface shared by completion registries. */
export type PiModelAuthSource = {
  getAvailable(): Array<Model<Api>>;
  getApiKey(provider: string): string | undefined;
  getHeaders(provider: string, modelId?: string): Record<string, string> | undefined;
};

const PI_API_STREAMS = {
  "anthropic-messages": anthropicMessagesApi(),
  "azure-openai-responses": azureOpenAIResponsesApi(),
  "bedrock-converse-stream": bedrockConverseStreamApi(),
  "google-generative-ai": googleGenerativeAIApi(),
  "google-vertex": googleVertexApi(),
  "mistral-conversations": mistralConversationsApi(),
  "openai-codex-responses": openAICodexResponsesApi(),
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
  "pi-messages": piMessagesApi(),
} satisfies Partial<Record<Api, ProviderStreams>>;

const API_STREAMS: Partial<Record<Api, ProviderStreams>> = Object.fromEntries(
  Object.entries(PI_API_STREAMS).map(([api, streams]) => [api, withImageInputs(withRequestProfiles(streams))]),
);

type ModelsCacheEntry = {
  signature: string;
  models: Models;
};

/** Cache Models per registry instance; rebuild only when catalog shape changes. */
const modelsCache = new WeakMap<PiModelAuthSource, ModelsCacheEntry>();

function modelFingerprint(model: Model<Api>): string {
  return [
    model.provider,
    model.id,
    model.api,
    model.baseUrl ?? "",
    model.reasoning ? "1" : "0",
    String(model.contextWindow ?? 0),
    String(model.maxTokens ?? 0),
    JSON.stringify(model.compat ?? null),
    JSON.stringify(model.headers ?? null),
  ].join("\0");
}

function catalogSignature(available: readonly Model<Api>[], focusModel?: Model<Api>): string {
  const fingerprints = available.map(modelFingerprint);
  if (
    focusModel &&
    !available.some(
      (model) => model.provider === focusModel.provider && model.id === focusModel.id,
    )
  ) {
    fingerprints.push(modelFingerprint(focusModel));
  }
  fingerprints.sort();
  return fingerprints.join("\n");
}

function buildModelsFromRegistry(
  registry: PiModelAuthSource,
  available: readonly Model<Api>[],
  focusModel?: Model<Api>,
): Models {
  const models = createModels();
  const byProvider = new Map<string, Model<Api>[]>();

  for (const model of available) {
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }

  if (focusModel && !byProvider.has(focusModel.provider)) {
    byProvider.set(focusModel.provider, [focusModel]);
  } else if (focusModel) {
    const list = byProvider.get(focusModel.provider) ?? [];
    if (!list.some((item) => item.id === focusModel.id)) {
      list.push(focusModel);
      byProvider.set(focusModel.provider, list);
    }
  }

  for (const [providerId, catalog] of byProvider) {
    const apiMap: Partial<Record<Api, ProviderStreams>> = {};
    for (const model of catalog) {
      const streams = API_STREAMS[model.api];
      if (streams) apiMap[model.api] = streams;
    }
    if (Object.keys(apiMap).length === 0) continue;

    models.setProvider(
      createProvider({
        id: providerId,
        name: providerId,
        models: catalog as readonly Model<Api>[],
        auth: {
          apiKey: {
            name: `${providerId} API key`,
            // Live provider-scoped lookup; Pi merges the selected model's headers later.
            resolve: async () => {
              const apiKey = registry.getApiKey(providerId);
              if (!apiKey) return undefined;
              return {
                auth: { apiKey },
                source: "cohub-model-registry",
              };
            },
          },
        },
        api: apiMap,
      }),
    );
  }

  return models;
}

/**
 * Build a pi-ai Models collection around a Cohub completion registry.
 * Cached per registry + catalog signature; auth still resolves live each request.
 */
export function createModelsFromRegistry(
  registry: PiModelAuthSource,
  focusModel?: Model<Api>,
): Models {
  const available = registry.getAvailable();
  const signature = catalogSignature(available, focusModel);
  const cached = modelsCache.get(registry);
  if (cached?.signature === signature) return cached.models;

  const models = buildModelsFromRegistry(registry, available, focusModel);
  modelsCache.set(registry, { signature, models });
  return models;
}

export function streamSimpleWithModels(
  models: Models,
  model: Model<Api>,
  context: Parameters<Models["streamSimple"]>[1],
  options?: SimpleStreamOptions & ImageInputOptions & { threadId?: string },
) {
  return models.streamSimple(model, context, options);
}
