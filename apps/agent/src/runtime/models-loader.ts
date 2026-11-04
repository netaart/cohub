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
  type ModelsConfigModLayer,
} from "@cohub/infra/config-runtime/models";
import { loadSpaceModModelsConfigs } from "@cohub/core/space-mods";
import { db } from "../db.js";
import { logger } from "../logger.js";
import { redis } from "../redis.js";
import { getAgentCheckpointCacheRoot, getAgentPlatformModelsPath, getAgentUserModelsPath } from "./paths.js";

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
    if (!input.allowMissing) throw error;
    if (code !== "ENOENT") {
      logger.warn(`[Models] ignoring invalid user models config at ${input.modelsPath}:`, error);
    }
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

export async function loadRuntimeModelsConfigs(
  userId?: string | null,
  spaceId?: string | null,
): Promise<ModelsConfig[]> {
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

  let mods: ModelsConfigModLayer[] = [];
  if (spaceId?.trim()) {
    const loaded = await loadSpaceModModelsConfigs(db, spaceId.trim(), {
      checkpointCacheRoot: getAgentCheckpointCacheRoot(),
    }).catch((error) => {
      logger.warn(`[Models] failed to load mod models configs spaceId=${spaceId}:`, error);
      return null;
    });
    for (const warning of loaded?.warnings ?? []) logger.warn(`[Models] ${warning}`);
    mods = (loaded?.configs ?? []).map((item) => ({ config: item.config, ref: item.ref }));
  }

  return [resolveRuntimeModelsConfig({ platform, mods, user })];
}
