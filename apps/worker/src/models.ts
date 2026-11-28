import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createCachedModelsConfig,
  getUserModelsRedisKey,
  findRuntimeModelCredential,
  MODELS_CACHE_TTL_SEC,
  parseCachedModelsConfig,
  parseModelsConfig,
  PLATFORM_MODELS_REDIS_KEY,
  resolveRuntimeModelsConfig,
  type ModelsConfig,
} from "@cohub/infra/config-runtime/models";
import type { UsageCredential } from "@cohub/protocol/runtime";
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

export async function resolvePromptModelCredential(input: { userId: string; provider: string; model: string }): Promise<UsageCredential | null> {
  const [platform, user] = await Promise.all([
    loadConfig(
      PLATFORM_MODELS_REDIS_KEY,
      join(config.platformConfigRoot, "platform", ".cohub", "models.json"),
      false,
    ),
    loadConfig(
      getUserModelsRedisKey(input.userId),
      join(config.platformConfigRoot, "users", input.userId, ".cohub", "models.json"),
      true,
    ),
  ]);
  return findRuntimeModelCredential([resolveRuntimeModelsConfig({ platform, user })], input.provider, input.model);
}
