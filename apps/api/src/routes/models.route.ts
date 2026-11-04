import { createLogger } from "@cohub/infra/logging";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import {
  createCachedModelsConfig,
  flattenModelsCatalog,
  getUserModelsRedisKey,
  MODELS_CACHE_TTL_SEC,
  parseCachedModelsConfig,
  parseModelsConfig,
  PLATFORM_MODELS_REDIS_KEY,
  DEFAULT_CONTEXT_WINDOW,
  resolveModelsConfigContext,
  type CachedModelsConfig,
  type ModelCatalogEntry,
  type ModelsConfig,
} from "@cohub/infra/config-runtime/models";
import { loadSpaceModModelLayers } from "@cohub/core/space-mods";
import { loadPublicGenerationModels } from "../generations/declarations.js";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { useAuth, authzDenied } from "../lib/middleware.js";
import { hasPermission } from "../permissions.js";
import { redisCommandClient } from "../redis.js";


const logger = createLogger({ serviceName: "cohub-api" });
const PLATFORM_MODELS_PATH = join(config.platformConfigRoot, "platform", ".cohub", "models.json");
const MULTIMODAL_MODEL_TYPE = "multimodal";
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
    if (code === "ENOENT") {
      throw new Error("Models catalog file not found");
    }
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

async function fetchModelsCatalog(userId: string, spaceId?: string | null): Promise<ModelCatalogEntry[]> {
  const modsPromise = loadSpaceModModelLayers(db, spaceId, {
    checkpointCacheRoot: config.checkpointCacheRoot,
    warn: (message) => logger.warn(`[models] ${message}`),
  });
  const platformModels = await loadCachedModels({
    redisKey: PLATFORM_MODELS_REDIS_KEY,
    modelsPath: PLATFORM_MODELS_PATH,
    allowMissing: false,
  });
  if (!platformModels) throw new Error("Models catalog file not found");

  const userModels = await loadCachedModels({
    redisKey: getUserModelsRedisKey(userId),
    modelsPath: getUserModelsPath(userId),
    allowMissing: true,
  });

  const resolved = resolveModelsConfigContext({ platform: platformModels, mods: await modsPromise, user: userModels });
  return flattenModelsCatalog(resolved).map((entry) => entry.model.contextWindow === undefined
    ? { ...entry, model: { ...entry.model, contextWindow: DEFAULT_CONTEXT_WINDOW, contextWindowSource: "default" } }
    : entry);
}

const router = new Hono();

router.get("/", async (c) => {
  // Auth check outside try/catch so UnauthorizedError propagates to
  // Hono's onError handler (returns 401) instead of being mis-reported
  // as a catalog loading failure.
  const user = useAuth(c);
  if (user instanceof Response) return user;

  try {
    const modelType = c.req.query("modelType");
    if (modelType === MULTIMODAL_MODEL_TYPE) {
      return c.json(await loadPublicGenerationModels(user.uuid));
    }

    const spaceId = c.req.query("spaceId")?.trim() || null;
    if (spaceId && !(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);

    const catalog = await fetchModelsCatalog(user.uuid, spaceId);
    const grouped: Record<string, ModelCatalogEntry[]> = {};
    for (const entry of catalog) {
      let list = grouped[entry.provider];
      if (!list) {
        list = [];
        grouped[entry.provider] = list;
      }
      list.push(entry);
    }
    return c.json(grouped);
  } catch (error) {
    logger.error("[models] failed to load catalog", error);
    return c.json({ message: "failed to load models catalog" }, 502);
  }
});

export default router;
