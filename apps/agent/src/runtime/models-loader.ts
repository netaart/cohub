import { readFile } from "node:fs/promises";
import {
  createCachedModelsConfig,
  getUserModelsRedisKey,
  MODELS_CACHE_TTL_SEC,
  parseCachedModelsConfig,
  parseModelsConfig,
  PLATFORM_MODELS_REDIS_KEY,
  resolveRuntimeModelsConfig,
  type CachedModelsConfig,
  type ModelsConfig,
} from "@cohub/infra/config-runtime/models";
import { redis } from "../redis.js";
import { getAgentPlatformModelsPath, getAgentUserModelsPath } from "./paths.js";

async function loadModelsFromFile(input: {
  modelsPath: string;
  redisKey: string;
  allowMissing: boolean;
}): Promise<CachedModelsConfig> {
  try {
    const rawText = await readFile(input.modelsPath, "utf-8");
    const content = parseModelsConfig(rawText);
    const cached = createCachedModelsConfig({ rawText, content });
    await redis.set(input.redisKey, JSON.stringify(cached), "EX", MODELS_CACHE_TTL_SEC);
    return cached;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code !== "ENOENT" || !input.allowMissing) throw error;
    const cached = createCachedModelsConfig({ content: null });
    await redis.set(input.redisKey, JSON.stringify(cached), "EX", MODELS_CACHE_TTL_SEC);
    return cached;
  }
}

async function loadCachedModels(input: {
  redisKey: string;
  modelsPath: string;
  allowMissing: boolean;
}): Promise<ModelsConfig | null> {
  const cached = await redis.get(input.redisKey);
  if (cached) {
    try {
      const parsed = parseCachedModelsConfig(cached);
      if (parsed) return parsed.content;
    } catch {
      // ignore cache parse errors and fall back to file
    }
  }

  return (await loadModelsFromFile(input)).content;
}

export async function loadRuntimeModelsConfigs(userId?: string | null): Promise<ModelsConfig[]> {
  const platform = await loadCachedModels({
    redisKey: PLATFORM_MODELS_REDIS_KEY,
    modelsPath: getAgentPlatformModelsPath(),
    allowMissing: false,
  });

  const trimmedUserId = userId?.trim();
  const user = trimmedUserId
    ? await loadCachedModels({
        redisKey: getUserModelsRedisKey(trimmedUserId),
        modelsPath: getAgentUserModelsPath(trimmedUserId),
        allowMissing: true,
      })
    : null;

  return [resolveRuntimeModelsConfig({ platform, user })];
}
