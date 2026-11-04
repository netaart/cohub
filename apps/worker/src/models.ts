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
  type ModelsConfig,
} from "@cohub/infra/config-runtime/models";
import { config } from "./config.js";
import { redisCommandClient } from "./redis.js";

type ModelsCacheClient = Pick<typeof redisCommandClient, "get" | "set">;
type ReadModelsFile = (path: string, encoding: "utf-8") => Promise<string>;

export async function loadConfig(
  redisKey: string,
  filePath: string,
  allowMissing: boolean,
  deps: { cache: ModelsCacheClient; readFile: ReadModelsFile } = {
    cache: redisCommandClient,
    readFile,
  },
): Promise<ModelsConfig | null> {
  const cached = await deps.cache.get(redisKey);
  if (cached) {
    const parsed = parseCachedModelsConfig(cached);
    if (parsed) return parsed.content;
  }

  let rawText: string;
  try {
    rawText = await deps.readFile(filePath, "utf-8");
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const missing = createCachedModelsConfig({ content: null });
    await deps.cache.set(redisKey, JSON.stringify(missing), "EX", MODELS_CACHE_TTL_SEC);
    return null;
  }

  const content = parseModelsConfig(rawText);
  const refreshed = createCachedModelsConfig({ rawText, content });
  await deps.cache.set(redisKey, JSON.stringify(refreshed), "EX", MODELS_CACHE_TTL_SEC);
  return content;
}

export async function validatePromptModel(input: { userId: string; provider: string; model: string }) {
  const configs = [
    await loadConfig(
      PLATFORM_MODELS_REDIS_KEY,
      join(config.platformConfigRoot, "platform", ".cohub", "models.json"),
      false,
    ),
    await loadConfig(
      getUserModelsRedisKey(input.userId),
      join(config.platformConfigRoot, "users", input.userId, ".cohub", "models.json"),
      true,
    ),
  ];
  return isRuntimeModelAvailable(configs, input.provider, input.model);
}
