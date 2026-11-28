import { Hono, type Context } from "hono";
import { sql, and, gte, lt, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "@cohub/db";
import { getSpacePublicProfile } from "../lib/middleware.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../user-profiles.js";
import {
  flattenModelsCatalog,
  parseModelsConfig,
  type ModelCatalogEntry,
} from "@cohub/infra/config-runtime/models";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { redisCommandClient } from "../redis.js";
import { asUsageCredential, publicUsageLabel } from "../usage-aggregation.js";
import { resolveHarness } from "@cohub/protocol/runtime";

const router = new Hono();

const TRENDING_HTTP_CACHE_MAX_AGE_SECONDS = 5 * 60;
const TRENDING_REDIS_CACHE_TTL_SECONDS = 24 * 60 * 60;
const TRENDING_STALE_WHILE_REVALIDATE_SECONDS = 60 * 60;
const PLATFORM_MODELS_PATH = join(config.platformConfigRoot, "platform", ".cohub", "models.json");

let platformModelsCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;

async function loadPlatformModelsCatalog(): Promise<ModelCatalogEntry[]> {
  platformModelsCatalogPromise ??= readFile(PLATFORM_MODELS_PATH, "utf-8")
    .then((rawText) => flattenModelsCatalog(parseModelsConfig(rawText)))
    .catch(() => []);
  return platformModelsCatalogPromise;
}

function getCatalogModelName(item: ModelCatalogEntry | null | undefined): string {
  const name = item?.model?.name;
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

function buildLlmModelDisplayName(
  catalog: ModelCatalogEntry[],
  provider: string,
  model: string,
): string {
  const item = catalog.find((entry) => entry.provider === provider && entry.id === model)
    ?? catalog.filter((entry) => entry.id === model).at(0)
    ?? null;
  return `${provider}/${getCatalogModelName(item) || model}`;
}

function buildGenerationModelDisplayName(provider: string, model: string): string {
  // Adapter types look like `openai.images` — prefer the model id for multimodal.
  if (provider.includes(".")) return model;
  return `${provider}/${model}`;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function setTrendingCacheHeaders(c: Context) {
  c.header(
    "Cache-Control",
    `public, max-age=${TRENDING_HTTP_CACHE_MAX_AGE_SECONDS}, stale-while-revalidate=${TRENDING_STALE_WHILE_REVALIDATE_SECONDS}`,
  );
}

function getTrendingCacheKey(name: string) {
  return `api:trending:${name}:${getYesterdayWindow().todayStart.toISOString()}`;
}

async function getCachedTrending<T>(name: string, load: () => Promise<T>): Promise<T> {
  const key = getTrendingCacheKey(name);

  try {
    const cached = await redisCommandClient.get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch {
    // Redis should not block the page.
  }

  const value = await load();

  try {
    await redisCommandClient.set(key, JSON.stringify(value), "EX", TRENDING_REDIS_CACHE_TTL_SECONDS);
  } catch {
    // Best-effort cache write.
  }

  return value;
}

/** Calculate yesterday's start (00:00) and today's start (00:00) as JS Dates */
function getYesterdayWindow() {
  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  return { yesterdayStart, todayStart };
}

// ─── LLM (token) leaderboards ─────────────────────────────────────────

async function loadTrendingSpaces() {
  const { yesterdayStart, todayStart } = getYesterdayWindow();

  const rows = await db
    .select({
      spaceId: schema.tokenUsageStatsHourly.spaceId,
      totalTokens: sql<number>`SUM(${schema.tokenUsageStatsHourly.totalTokens})`.as("total_tokens"),
      costTotal: sql<string>`SUM(${schema.tokenUsageStatsHourly.costTotal})`.as("cost_total"),
      sessionCount: sql<number>`COUNT(DISTINCT ${schema.tokenUsageStatsHourly.sessionId})`.as("session_count"),
      requestCount: sql<number>`SUM(${schema.tokenUsageStatsHourly.requestCount})`.as("request_count"),
    })
    .from(schema.tokenUsageStatsHourly)
    .where(
      and(
        gte(schema.tokenUsageStatsHourly.bucketStartAt, yesterdayStart),
        lt(schema.tokenUsageStatsHourly.bucketStartAt, todayStart),
      ),
    )
    .groupBy(schema.tokenUsageStatsHourly.spaceId)
    .orderBy(sql`total_tokens DESC`)
    .limit(10);

  if (rows.length === 0) return [];

  const spaceIds = rows.map((r) => r.spaceId as string);
  const spaces = await db
    .select({
      id: schema.spaces.id,
      name: schema.spaces.name,
      userUuid: schema.spaces.userUuid,
      meta: schema.spaces.meta,
    })
    .from(schema.spaces)
    .where(sql`${schema.spaces.id} IN (${sql.join(spaceIds, sql`, `)})`);

  const nameMap = new Map(spaces.map((s) => [s.id, s.name]));
  const userMap = new Map(spaces.map((s) => [s.id, s.userUuid]));
  const spaceProfileMap = new Map(spaces.map((s) => [s.id, getSpacePublicProfile(s)]));
  const profileMap = await getProfilesByUuids(spaces.map((s) => s.userUuid));

  return rows.map((r, i) => {
    const uid = userMap.get(r.spaceId as string) ?? "";
    const userProfile = profileMap.get(uid) ?? fallbackPublicUserProfile(uid);
    return {
      rank: i + 1,
      spaceId: r.spaceId,
      spaceName: nameMap.get(r.spaceId) ?? r.spaceId.slice(0, 8),
      userId: uid,
      userDisplay: userProfile.displayName,
      userProfile,
      spaceProfile: spaceProfileMap.get(r.spaceId as string) ?? { avatarUrl: null },
      totalTokens: toFiniteNumber(r.totalTokens),
      costTotal: toFiniteNumber(r.costTotal),
      sessionCount: toFiniteNumber(r.sessionCount),
      requestCount: toFiniteNumber(r.requestCount),
    };
  });
}

async function loadTrendingUsers() {
  const { yesterdayStart, todayStart } = getYesterdayWindow();

  const rows = await db
    .select({
      userId: schema.tokenUsageStatsHourly.userId,
      totalTokens: sql<number>`SUM(${schema.tokenUsageStatsHourly.totalTokens})`.as("total_tokens"),
      costTotal: sql<string>`SUM(${schema.tokenUsageStatsHourly.costTotal})`.as("cost_total"),
      sessionCount: sql<number>`COUNT(DISTINCT ${schema.tokenUsageStatsHourly.sessionId})`.as("session_count"),
      requestCount: sql<number>`SUM(${schema.tokenUsageStatsHourly.requestCount})`.as("request_count"),
    })
    .from(schema.tokenUsageStatsHourly)
    .where(
      and(
        gte(schema.tokenUsageStatsHourly.bucketStartAt, yesterdayStart),
        lt(schema.tokenUsageStatsHourly.bucketStartAt, todayStart),
      ),
    )
    .groupBy(schema.tokenUsageStatsHourly.userId)
    .orderBy(sql`total_tokens DESC`)
    .limit(10);

  const profileMap = await getProfilesByUuids(
    rows.map((r) => r.userId).filter((userId): userId is string => Boolean(userId)),
  );

  return rows.map((r, i) => {
    const userId = r.userId ?? "";
    const userProfile = profileMap.get(userId) ?? fallbackPublicUserProfile(userId);
    return {
      rank: i + 1,
      userId,
      userDisplay: userProfile.displayName,
      userProfile,
      totalTokens: toFiniteNumber(r.totalTokens),
      costTotal: toFiniteNumber(r.costTotal),
      sessionCount: toFiniteNumber(r.sessionCount),
      requestCount: toFiniteNumber(r.requestCount),
    };
  });
}

async function loadTrendingModels() {
  const { yesterdayStart, todayStart } = getYesterdayWindow();
  const modelsCatalog = await loadPlatformModelsCatalog();
  const usage = schema.tokenUsageStatsHourly;
  const provider = publicUsageLabel(usage.provider);

  const rows = await db
    .select({
      harness: usage.harness,
      credential: usage.credential,
      provider,
      model: usage.model,
      totalTokens: sql<number>`SUM(${usage.totalTokens})`.as("total_tokens"),
      costTotal: sql<string>`SUM(${usage.costTotal})`.as("cost_total"),
      sessionCount: sql<number>`COUNT(DISTINCT ${usage.sessionId})`.as("session_count"),
      requestCount: sql<number>`SUM(${usage.requestCount})`.as("request_count"),
    })
    .from(usage)
    .where(and(gte(usage.bucketStartAt, yesterdayStart), lt(usage.bucketStartAt, todayStart)))
    .groupBy(usage.harness, usage.credential, provider, usage.model)
    .orderBy(sql`total_tokens DESC`)
    .limit(10);

  return rows.map((r, i) => {
    const credential = asUsageCredential(r.credential);
    const provider = r.provider ?? "unknown";
    const model = r.model ?? "unknown";
    return {
      rank: i + 1,
      harness: resolveHarness(r),
      credential,
      provider,
      model,
      modelDisplay: credential === "platform" ? buildLlmModelDisplayName(modelsCatalog, provider, model) : `${provider}/${model}`,
      totalTokens: toFiniteNumber(r.totalTokens),
      costTotal: toFiniteNumber(r.costTotal),
      sessionCount: toFiniteNumber(r.sessionCount),
      requestCount: toFiniteNumber(r.requestCount),
    };
  });
}

// ─── Multimodal generation leaderboards ───────────────────────────────

async function loadGenerationTrendingSpaces() {
  const { yesterdayStart, todayStart } = getYesterdayWindow();

  const rows = await db
    .select({
      spaceId: schema.generationUsageStatsHourly.spaceId,
      costTotal: sql<string>`SUM(${schema.generationUsageStatsHourly.costTotal})`.as("cost_total"),
      sessionCount: sql<number>`COUNT(DISTINCT ${schema.generationUsageStatsHourly.sessionId})`.as("session_count"),
      requestCount: sql<number>`SUM(${schema.generationUsageStatsHourly.requestCount})`.as("request_count"),
    })
    .from(schema.generationUsageStatsHourly)
    .where(
      and(
        gte(schema.generationUsageStatsHourly.bucketStartAt, yesterdayStart),
        lt(schema.generationUsageStatsHourly.bucketStartAt, todayStart),
      ),
    )
    .groupBy(schema.generationUsageStatsHourly.spaceId)
    .orderBy(sql`request_count DESC`, sql`cost_total DESC`)
    .limit(10);

  if (rows.length === 0) return [];

  const spaceIds = rows.map((r) => r.spaceId as string);
  const spaces = await db
    .select({
      id: schema.spaces.id,
      name: schema.spaces.name,
      userUuid: schema.spaces.userUuid,
      meta: schema.spaces.meta,
    })
    .from(schema.spaces)
    .where(sql`${schema.spaces.id} IN (${sql.join(spaceIds, sql`, `)})`);

  const nameMap = new Map(spaces.map((s) => [s.id, s.name]));
  const userMap = new Map(spaces.map((s) => [s.id, s.userUuid]));
  const spaceProfileMap = new Map(spaces.map((s) => [s.id, getSpacePublicProfile(s)]));
  const profileMap = await getProfilesByUuids(spaces.map((s) => s.userUuid));

  return rows.map((r, i) => {
    const uid = userMap.get(r.spaceId as string) ?? "";
    const userProfile = profileMap.get(uid) ?? fallbackPublicUserProfile(uid);
    return {
      rank: i + 1,
      spaceId: r.spaceId,
      spaceName: nameMap.get(r.spaceId) ?? r.spaceId.slice(0, 8),
      userId: uid,
      userDisplay: userProfile.displayName,
      userProfile,
      spaceProfile: spaceProfileMap.get(r.spaceId as string) ?? { avatarUrl: null },
      costTotal: toFiniteNumber(r.costTotal),
      sessionCount: toFiniteNumber(r.sessionCount),
      requestCount: toFiniteNumber(r.requestCount),
    };
  });
}

async function loadGenerationTrendingUsers() {
  const { yesterdayStart, todayStart } = getYesterdayWindow();

  const rows = await db
    .select({
      userId: schema.generationUsageStatsHourly.userId,
      costTotal: sql<string>`SUM(${schema.generationUsageStatsHourly.costTotal})`.as("cost_total"),
      sessionCount: sql<number>`COUNT(DISTINCT ${schema.generationUsageStatsHourly.sessionId})`.as("session_count"),
      requestCount: sql<number>`SUM(${schema.generationUsageStatsHourly.requestCount})`.as("request_count"),
    })
    .from(schema.generationUsageStatsHourly)
    .where(
      and(
        gte(schema.generationUsageStatsHourly.bucketStartAt, yesterdayStart),
        lt(schema.generationUsageStatsHourly.bucketStartAt, todayStart),
        isNotNull(schema.generationUsageStatsHourly.userId),
        ne(schema.generationUsageStatsHourly.userId, "unknown"),
      ),
    )
    .groupBy(schema.generationUsageStatsHourly.userId)
    .orderBy(sql`request_count DESC`, sql`cost_total DESC`)
    .limit(10);

  const profileMap = await getProfilesByUuids(
    rows.map((r) => r.userId).filter((userId): userId is string => Boolean(userId)),
  );

  return rows.map((r, i) => {
    const userId = r.userId ?? "";
    const userProfile = profileMap.get(userId) ?? fallbackPublicUserProfile(userId);
    return {
      rank: i + 1,
      userId,
      userDisplay: userProfile.displayName,
      userProfile,
      costTotal: toFiniteNumber(r.costTotal),
      sessionCount: toFiniteNumber(r.sessionCount),
      requestCount: toFiniteNumber(r.requestCount),
    };
  });
}

async function loadGenerationTrendingModels() {
  const { yesterdayStart, todayStart } = getYesterdayWindow();

  const rows = await db
    .select({
      provider: schema.generationUsageStatsHourly.provider,
      model: schema.generationUsageStatsHourly.model,
      costTotal: sql<string>`SUM(${schema.generationUsageStatsHourly.costTotal})`.as("cost_total"),
      sessionCount: sql<number>`COUNT(DISTINCT ${schema.generationUsageStatsHourly.sessionId})`.as("session_count"),
      requestCount: sql<number>`SUM(${schema.generationUsageStatsHourly.requestCount})`.as("request_count"),
    })
    .from(schema.generationUsageStatsHourly)
    .where(
      and(
        gte(schema.generationUsageStatsHourly.bucketStartAt, yesterdayStart),
        lt(schema.generationUsageStatsHourly.bucketStartAt, todayStart),
      ),
    )
    .groupBy(schema.generationUsageStatsHourly.provider, schema.generationUsageStatsHourly.model)
    .orderBy(sql`request_count DESC`, sql`cost_total DESC`)
    .limit(10);

  return rows.map((r, i) => {
    const provider = r.provider ?? "unknown";
    const model = r.model ?? "unknown";
    return {
      rank: i + 1,
      provider,
      model,
      modelDisplay: buildGenerationModelDisplayName(provider, model),
      costTotal: toFiniteNumber(r.costTotal),
      sessionCount: toFiniteNumber(r.sessionCount),
      requestCount: toFiniteNumber(r.requestCount),
    };
  });
}

// ─── Routes ───────────────────────────────────────────────────────────

router.get("/spaces", async (c) => {
  setTrendingCacheHeaders(c);
  return c.json(await getCachedTrending("spaces", loadTrendingSpaces));
});

router.get("/users", async (c) => {
  setTrendingCacheHeaders(c);
  return c.json(await getCachedTrending("users", loadTrendingUsers));
});

router.get("/models", async (c) => {
  setTrendingCacheHeaders(c);
  return c.json(await getCachedTrending("models:v2", loadTrendingModels));
});

router.get("/generations/spaces", async (c) => {
  setTrendingCacheHeaders(c);
  return c.json(await getCachedTrending("generations-spaces", loadGenerationTrendingSpaces));
});

router.get("/generations/users", async (c) => {
  setTrendingCacheHeaders(c);
  return c.json(await getCachedTrending("generations-users", loadGenerationTrendingUsers));
});

router.get("/generations/models", async (c) => {
  setTrendingCacheHeaders(c);
  return c.json(await getCachedTrending("generations-models", loadGenerationTrendingModels));
});

export default router;
