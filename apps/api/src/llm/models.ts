import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createCachedModelsConfig,
  getUserModelsRedisKey,
  isRuntimeModelAvailable,
  MODELS_CACHE_TTL_SEC,
  parseCachedModelsConfig,
  parseModelsConfig,
  PLATFORM_MODELS_REDIS_KEY,
  resolveRuntimeModelsConfig,
  type CachedModelsConfig,
  type ModelsConfig,
} from "@cohub/infra/config-runtime/models";
import { config } from "../config.js";
import { redisCommandClient } from "../redis.js";
import { CompletionModelRegistry, type RuntimeLlmModel } from "./completion-registry.js";

const PLATFORM_MODELS_PATH = join(config.platformConfigRoot, "platform", ".cohub", "models.json");
const getUserModelsPath = (userId: string) => join(config.platformConfigRoot, "users", userId, ".cohub", "models.json");

const inflightByKey = new Map<string, Promise<ModelsConfig | null>>();

async function loadModelsFromFile(input: {
  modelsPath: string;
  redisKey: string;
  allowMissing: boolean;
}): Promise<CachedModelsConfig> {
  let rawText: string;
  try {
    rawText = await readFile(input.modelsPath, "utf-8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code === "ENOENT" && input.allowMissing) {
      const cached = createCachedModelsConfig({ content: null });
      await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", MODELS_CACHE_TTL_SEC);
      return cached;
    }
    if (code === "ENOENT") throw new Error("Models catalog file not found");
    throw error;
  }

  let content: ModelsConfig;
  try {
    content = parseModelsConfig(rawText);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Models catalog file is invalid JSON");
    throw error;
  }

  const cached = createCachedModelsConfig({ rawText, content });
  await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", MODELS_CACHE_TTL_SEC);
  return cached;
}

async function loadCachedModels(input: {
  redisKey: string;
  modelsPath: string;
  allowMissing: boolean;
}): Promise<ModelsConfig | null> {
  const inflight = inflightByKey.get(input.redisKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const cached = await redisCommandClient.get(input.redisKey);
    if (cached) {
      try {
        const parsed = parseCachedModelsConfig(cached);
        if (parsed) return parsed.content;
      } catch {
        // ignore cache parse errors and fall back to file
      }
    }
    return (await loadModelsFromFile(input)).content;
  })();

  inflightByKey.set(input.redisKey, promise);
  try {
    return await promise;
  } finally {
    inflightByKey.delete(input.redisKey);
  }
}

export async function loadRuntimeModelsConfigs(userId?: string | null): Promise<ModelsConfig[]> {
  const platform = await loadCachedModels({
    redisKey: PLATFORM_MODELS_REDIS_KEY,
    modelsPath: PLATFORM_MODELS_PATH,
    allowMissing: false,
  });
  const trimmedUserId = userId?.trim();
  const user = trimmedUserId
    ? await loadCachedModels({
        redisKey: getUserModelsRedisKey(trimmedUserId),
        modelsPath: getUserModelsPath(trimmedUserId),
        allowMissing: true,
      })
    : null;
  return [resolveRuntimeModelsConfig({ platform, user })];
}

export async function validatePromptModel(input: {
  userId: string;
  provider?: string | null;
  model?: string | null;
}) {
  const modelId = input.model?.trim();
  if (!modelId) return true;
  const provider = input.provider?.trim() || "cohub";
  return isRuntimeModelAvailable(await loadRuntimeModelsConfigs(input.userId), provider, modelId);
}

export async function resolveCompletionModel(input: {
  userId: string;
  provider?: string | null;
  model?: string | null;
}) {
  const configs = await loadRuntimeModelsConfigs(input.userId);
  const registry = new CompletionModelRegistry(configs);
  const provider = input.provider?.trim() || null;
  const modelId = input.model?.trim() || null;

  if (provider && modelId) {
    const found = registry.find(provider, modelId);
    if (!found) {
      return { registry, model: null as RuntimeLlmModel | null, error: `Model not found: ${provider}/${modelId}` };
    }
    return { registry, model: found, error: null };
  }

  if (modelId && !provider) {
    const matches = registry.getAvailable().filter((item) => item.id === modelId);
    const only = matches[0];
    if (matches.length === 1 && only) return { registry, model: only, error: null };
    if (matches.length > 1) {
      return {
        registry,
        model: null,
        error: `Model id "${modelId}" is ambiguous; specify provider`,
      };
    }
    return { registry, model: null, error: `Model not found: ${modelId}` };
  }

  if (provider && !modelId) {
    const first = registry.getDiscoverable().find((item) => item.provider === provider)
      ?? registry.getAvailable().find((item) => item.provider === provider);
    if (!first) return { registry, model: null, error: `No models available for provider: ${provider}` };
    return { registry, model: first, error: null };
  }

  const fallback = registry.getDefault();
  if (!fallback) return { registry, model: null, error: "No model available. Check platform models.json" };
  return { registry, model: fallback, error: null };
}
