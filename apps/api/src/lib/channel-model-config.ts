import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createCachedModelsConfig,
  getUserModelsRedisKey,
  MODELS_CACHE_TTL_SEC,
  parseCachedModelsConfig,
  parseModelsConfig,
  PLATFORM_MODELS_REDIS_KEY,
  resolveModelsConfigContext,
  type ModelsConfig,
  type ModelsConfigModLayer,
} from "@cohub/infra/config-runtime/models";
import { loadSpaceModModelsConfigs } from "@cohub/core/space-mods";
import { createLogger } from "@cohub/infra/logging";
import type { ChannelConfig } from "@cohub/protocol/gateway";
import type { InferSelectModel } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { spaces } from "@cohub/db";
import type { db as dbClient } from "../db/index.js";
import { config } from "../config.js";
import { redisCommandClient } from "../redis.js";

const logger = createLogger({ serviceName: "cohub-api" });

type DbClient = typeof dbClient;
type SpaceRow = InferSelectModel<typeof spaces>;

export type ChannelModelSelection = {
  provider: string;
  id: string;
  thinkingLevel?: string | null;
};

export type ResolvedChannelModelSelection = ChannelModelSelection & {
  display: string;
};

const MAX_CHANNEL_CONFIG_BYTES = 16 * 1024;
const PLATFORM_MODELS_PATH = join(config.platformConfigRoot, "platform", ".cohub", "models.json");
const getUserModelsPath = (userId: string) => join(config.platformConfigRoot, "users", userId, ".cohub", "models.json");

const loadModelsConfig = async (input: {
  redisKey: string;
  modelsPath: string;
  allowMissing: boolean;
}): Promise<ModelsConfig | null> => {
  const cached = await redisCommandClient.get(input.redisKey);
  if (cached) {
    const parsed = parseCachedModelsConfig(cached);
    if (parsed) return parsed.content;
  }

  let rawText: string;
  try {
    rawText = await readFile(input.modelsPath, "utf-8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code === "ENOENT" && input.allowMissing) {
      const missing = createCachedModelsConfig({ content: null });
      await redisCommandClient.set(input.redisKey, JSON.stringify(missing), "EX", MODELS_CACHE_TTL_SEC).catch(() => undefined);
      return null;
    }
    throw error;
  }

  let content: ModelsConfig;
  try {
    content = parseModelsConfig(rawText);
  } catch (error) {
    if (input.allowMissing) {
      logger.warn(`[Models] ignoring invalid user models config at ${input.modelsPath}:`, error);
      return null;
    }
    throw error;
  }
  const cacheValue = createCachedModelsConfig({ rawText, content });
  await redisCommandClient.set(input.redisKey, JSON.stringify(cacheValue), "EX", MODELS_CACHE_TTL_SEC).catch(() => undefined);
  return content;
};

export function normalizeChannelModelConfig(value: unknown): ChannelModelSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!provider || !id) return null;
  const thinkingLevel = typeof record.thinkingLevel === "string" && record.thinkingLevel.trim() ? record.thinkingLevel.trim() : null;
  return thinkingLevel ? { provider, id, thinkingLevel } : { provider, id };
}

export function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function loadMergedModelsCatalog(db: DbClient, spaceOrId: Pick<SpaceRow, "id" | "userUuid"> | string) {
  const space = typeof spaceOrId === "string"
    ? (await db.select({ id: spaces.id, userUuid: spaces.userUuid }).from(spaces).where(eq(spaces.id, spaceOrId)).limit(1))[0]
    : spaceOrId;
  const platformModels = await loadModelsConfig({
    redisKey: PLATFORM_MODELS_REDIS_KEY,
    modelsPath: PLATFORM_MODELS_PATH,
    allowMissing: false,
  });
  const [userModels, mods] = await Promise.all([
    space?.userUuid
      ? loadModelsConfig({
          redisKey: getUserModelsRedisKey(space.userUuid),
          modelsPath: getUserModelsPath(space.userUuid),
          allowMissing: true,
        })
      : null,
    loadModModelsConfigs(db, space?.id),
  ]);
  return resolveModelsConfigContext({ platform: platformModels, mods, user: userModels });
}

async function loadModModelsConfigs(db: DbClient, spaceId?: string | null): Promise<ModelsConfigModLayer[]> {
  if (!spaceId?.trim()) return [];
  const loaded = await loadSpaceModModelsConfigs(db, spaceId.trim(), {
    checkpointCacheRoot: config.checkpointCacheRoot,
  }).catch(() => null);
  return (loaded?.configs ?? []).map((item) => ({ config: item.config, ref: item.ref }));
}

export function splitProviderModelInput(value: string): { provider: string | null; id: string } {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex < 0) return { provider: null, id: trimmed };
  return {
    provider: trimmed.slice(0, separatorIndex).trim() || null,
    id: trimmed.slice(separatorIndex + 1).trim(),
  };
}

export async function resolveChannelModelSelection(db: DbClient, spaceId: string, rawInput: string): Promise<ResolvedChannelModelSelection | null> {
  const query = rawInput.trim();
  if (!query) return null;
  const catalog = await loadMergedModelsCatalog(db, spaceId);
  const { provider: providerFilter, id: modelId } = splitProviderModelInput(query);
  const matches: ResolvedChannelModelSelection[] = [];

  for (const [provider, providerConfig] of Object.entries(catalog.providers)) {
    if (providerFilter && provider !== providerFilter) continue;
    for (const model of providerConfig.models ?? []) {
      if (model.id !== modelId) continue;
      matches.push({ provider, id: model.id, display: `${provider}/${model.name || model.id}` });
    }
  }

  return matches.length === 1 ? matches[0] ?? null : null;
}

export async function validateChannelModelConfig(db: DbClient, spaceId: string, model: ChannelModelSelection | null) {
  if (!model) return true;
  const resolved = await resolveChannelModelSelection(db, spaceId, `${model.provider}/${model.id}`);
  return Boolean(resolved && resolved.provider === model.provider && resolved.id === model.id);
}

export function parseChannelConfigPatch(value: unknown): ChannelConfig | null {
  if (value == null) return null;
  const config = getRecord(value);
  if (!config) throw new Error("config must be an object");
  const serialized = JSON.stringify(config);
  if (serialized.length > MAX_CHANNEL_CONFIG_BYTES) throw new Error("config is too large");

  const next: Record<string, unknown> = { ...config };
  if ("model" in config) {
    if (config.model !== null && normalizeChannelModelConfig(config.model) === null) {
      throw new Error("model must use provider and id");
    }
    next.model = normalizeChannelModelConfig(config.model);
  }
  return next as ChannelConfig;
}

export function mergeChannelConfig(current: unknown, patch: ChannelConfig | null): ChannelConfig | null {
  const base = getRecord(current) ?? {};
  if (!patch) return null;
  const next = { ...base, ...patch };
  if ("model" in patch && patch.model == null) delete next.model;
  return Object.keys(next).length > 0 ? next as ChannelConfig : null;
}
