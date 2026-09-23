import {
  bindModSkillsConfig,
  bindSpaceModSkillsConfig,
  createCachedSkillsConfig,
  createSkillLoader,
  getDirectoryRevision,
  getModSkillsRedisKey,
  getSpaceModSkillsRedisKey,
  getUserSkillsRedisKey,
  loadSkillsFromDirectory,
  mergeSkillsConfigs,
  parseCachedSkillsConfig,
  PLATFORM_SKILLS_REDIS_KEY,
  SKILLS_CACHE_TTL_SEC,
  toSkillCatalog,
  type CachedSkillsConfig,
  type ModSkillBinding,
  type SkillCatalogEntry,
  type SkillLoader,
  type SkillScope,
  type SkillScopeLoader,
  type SkillsConfig,
} from "@cohub/infra/config-runtime/skills";
import { join, resolve } from "node:path";
import { spaceSandboxes } from "@cohub/db";
import { eq } from "drizzle-orm";
import { getSpaceModMountSignature, listEnabledSpaceMods } from "@cohub/core/space-mods";
import type { PromptHarness } from "@cohub/core/sessions";
import { createLogger } from "@cohub/infra/logging";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { redisCommandClient } from "./redis.js";

const logger = createLogger({ serviceName: "cohub-api" });

export type { SkillCatalogEntry } from "@cohub/infra/config-runtime/skills";

export type ExpandedSkill = {
  renderedText: string;
  skill: SkillCatalogEntry & {
    sandboxFilePath: string;
    sandboxBaseDir: string;
  };
  argsText: string;
  rawInput: string;
};

export type LoadSkillsOptions = {
  userId?: string | null;
  spaceId?: string | null;
  /** Executing Harness of the turn being expanded. Catalog listings omit it
   * and filter by the space's sandbox provider instead. */
  harness?: PromptHarness | null;
};

const SKILLS_DIR = ".agents/skills";
const CHECKPOINT_META_PATH = ".cohub/system/checkpoint-meta.v1.json";
const SANDBOX_PLATFORM_SKILLS_PATH = "/configs/platform/.agents/skills";
const SANDBOX_USER_SKILLS_PATH = "/configs/user/.agents/skills";
const SANDBOX_WORKSPACE_SKILLS_PATH = "/workspace/.agents/skills";

const inflightByCacheKey = new Map<string, Promise<SkillsConfig | null>>();

function getPlatformSkillsDir() {
  return join(config.platformConfigRoot, "platform", SKILLS_DIR);
}

function getUserSkillsDir(userId: string) {
  return join(config.platformConfigRoot, "users", userId, SKILLS_DIR);
}

function getProjectSkillsDir(spaceId: string) {
  return resolve(config.spaceStorageRoot, spaceId, "workspace", SKILLS_DIR);
}

/**
 * Project skills read the server-side workspace copy. For local sandboxes the
 * authoritative workspace lives on the user's machine; the copy reflects the
 * last checkpoint, and native Harnesses resolve locations relative to their
 * workspace cwd.
 */
async function loadProjectSkills(spaceId: string): Promise<SkillsConfig> {
  const { content } = await loadSkillsFromDirectory({
    dir: getProjectSkillsDir(spaceId),
    sandboxDir: SANDBOX_WORKSPACE_SKILLS_PATH,
    scope: "project",
  });
  return content;
}

function getModLatestDir(modSpaceId: string) {
  return resolve(config.checkpointCacheRoot, modSpaceId, "latest");
}

function getModSkillsDir(modSpaceId: string) {
  return resolve(getModLatestDir(modSpaceId), SKILLS_DIR);
}

async function loadSkillsFromDir(input: {
  dir: string;
  sandboxDir: string;
  redisKey: string;
  scope: SkillScope;
  allowMissing: boolean;
}): Promise<CachedSkillsConfig> {
  try {
    const { rawText, content } = await loadSkillsFromDirectory(input);
    const cached = createCachedSkillsConfig({ rawText, content });
    await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", SKILLS_CACHE_TTL_SEC).catch(() => undefined);
    return cached;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code !== "ENOENT" || !input.allowMissing) throw error;
    const cached = createCachedSkillsConfig({ rawText: "", content: { skills: [] } });
    await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", SKILLS_CACHE_TTL_SEC).catch(() => undefined);
    return cached;
  }
}

async function loadCachedSkills(input: {
  redisKey: string;
  dir: string;
  sandboxDir: string;
  scope: SkillScope;
  allowMissing: boolean;
}): Promise<SkillsConfig | null> {
  const inflight = inflightByCacheKey.get(input.redisKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const cached = await redisCommandClient.get(input.redisKey).catch(() => null);
    if (cached) {
      const parsed = parseCachedSkillsConfig(cached);
      if (parsed) return parsed.content;
    }
    return (await loadSkillsFromDir(input)).content;
  })();

  inflightByCacheKey.set(input.redisKey, promise);
  try {
    return await promise;
  } finally {
    inflightByCacheKey.delete(input.redisKey);
  }
}

type SpaceModSkillSource = ModSkillBinding & {
  revision: string;
};

function getModSkillsLoadInput(source: SpaceModSkillSource) {
  return {
    redisKey: getModSkillsRedisKey(source.modSpaceId, source.revision),
    dir: source.skillsDir,
    sandboxDir: source.sandboxDir,
    scope: "mod" as const,
    allowMissing: true,
  };
}

async function loadBoundModSkills(spaceId: string, source: SpaceModSkillSource): Promise<{
  config: SkillsConfig | null;
  cacheable: boolean;
}> {
  const loadInput = getModSkillsLoadInput(source);
  try {
    const cached = await loadCachedSkills(loadInput);
    if (!cached) return { config: null, cacheable: true };
    try {
      return { config: bindModSkillsConfig(cached, source), cacheable: true };
    } catch (error) {
      logger.warn("[skills] invalid Mod skill cache; reloading from disk", {
        spaceId,
        modSpaceId: source.modSpaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      await redisCommandClient.del(loadInput.redisKey).catch(() => undefined);
      const refreshed = (await loadSkillsFromDir(loadInput)).content;
      return { config: refreshed ? bindModSkillsConfig(refreshed, source) : null, cacheable: true };
    }
  } catch (error) {
    await redisCommandClient.del(loadInput.redisKey).catch(() => undefined);
    logger.warn("[skills] failed to load Mod skills; skipping source", {
      spaceId,
      modSpaceId: source.modSpaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { config: null, cacheable: false };
  }
}

async function loadSpaceModSkills(spaceId: string): Promise<SkillsConfig | null> {
  const mods = await listEnabledSpaceMods(db, spaceId);
  if (mods.length === 0) return null;

  const signature = getSpaceModMountSignature(mods);
  const sources: SpaceModSkillSource[] = await Promise.all(mods.map(async (mod) => {
    const latestDir = getModLatestDir(mod.modSpaceId);
    return {
      skillsDir: getModSkillsDir(mod.modSpaceId),
      sandboxDir: `${mod.mountPath}/.agents/skills`,
      modSpaceId: mod.modSpaceId,
      mountSlug: mod.mountSlug,
      revision: await getDirectoryRevision(latestDir, join(latestDir, CHECKPOINT_META_PATH)),
    };
  }));
  const aggregateKey = getSpaceModSkillsRedisKey(
    spaceId,
    JSON.stringify({ signature, revisions: sources.map((source) => [source.modSpaceId, source.revision]) }),
  );

  const cached = await redisCommandClient.get(aggregateKey).catch(() => null);
  if (cached) {
    const parsed = parseCachedSkillsConfig(cached);
    if (parsed?.content) {
      try {
        return bindSpaceModSkillsConfig(parsed.content, sources);
      } catch (error) {
        logger.warn("[skills] invalid aggregate Mod skill cache; rebuilding", {
          spaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await redisCommandClient.del(aggregateKey).catch(() => undefined);
  }

  const results = await Promise.all(sources.map((source) => loadBoundModSkills(spaceId, source)));
  const content = mergeSkillsConfigs(...results.map((result) => result.config));
  if (results.every((result) => result.cacheable)) {
    const aggregate = createCachedSkillsConfig({ rawText: aggregateKey, content });
    await redisCommandClient.set(aggregateKey, JSON.stringify(aggregate), "EX", SKILLS_CACHE_TTL_SEC).catch(() => undefined);
  }
  return content;
}

/** A missing sandbox record is the cloud default (cloud spaces register lazily);
 * a failed lookup is logged here and fails closed inside the loader. */
const getSandboxProvider = async (spaceId: string): Promise<"cloud" | "local" | null> => {
  const [row] = await db
    .select({ provider: spaceSandboxes.provider })
    .from(spaceSandboxes)
    .where(eq(spaceSandboxes.spaceId, spaceId))
    .limit(1);
  const provider = row?.provider;
  return provider === "local" || provider === "cloud" ? provider : null;
};

const scopeLoaders: SkillScopeLoader = {
  platform: () => loadCachedSkills({
    redisKey: PLATFORM_SKILLS_REDIS_KEY,
    dir: getPlatformSkillsDir(),
    sandboxDir: SANDBOX_PLATFORM_SKILLS_PATH,
    scope: "platform",
    allowMissing: true,
  }),
  mod: loadSpaceModSkills,
  user: (userId) => loadCachedSkills({
    redisKey: getUserSkillsRedisKey(userId),
    dir: getUserSkillsDir(userId),
    sandboxDir: SANDBOX_USER_SKILLS_PATH,
    scope: "user",
    allowMissing: true,
  }),
  project: async (spaceId) => (config.spaceStorageRoot ? loadProjectSkills(spaceId) : null),
};

const skillLoader: SkillLoader = createSkillLoader({
  scopes: scopeLoaders,
  getSandboxProvider: (spaceId) => getSandboxProvider(spaceId).catch((error) => {
    logger.warn("[skills] failed to resolve sandbox provider; failing closed to workspace skills", {
      spaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }),
});

export async function listSkills(options: LoadSkillsOptions = {}): Promise<SkillCatalogEntry[]> {
  return toSkillCatalog(await skillLoader.fetch(options));
}

export async function expandSkillCommand(text: string, options: LoadSkillsOptions = {}): Promise<ExpandedSkill | null> {
  return skillLoader.expand(text, options);
}
