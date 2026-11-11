import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { appViewStatsHourly, apps, cronJobs, resourceLikeCounts, taskRuns } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { db } from "./db/index.js";
import { createSpaceCommerceSdk, getSpaceCommerceBusinessKey } from "./lib/space-commerce.js";

const logger = createLogger({ serviceName: "cohub-api" });

export const SPACE_OVERVIEW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const VIEWS_CACHE_TTL_SECONDS = 60;
const REVENUE_CACHE_TTL_SECONDS = 10 * 60;
const REVENUE_PAGE_LIMIT = 100;
const REVENUE_MAX_PAGES = 10;
const REVENUE_WAIT_MS = 3000;

export type SpaceOverviewRevenue = {
  usd: number;
  partial: boolean;
};

export type SpaceOverview = {
  days: number;
  apps: {
    count: number;
    views: number;
    likes: number;
    revenue: SpaceOverviewRevenue | null;
  };
  schedules: { active: number; runs: number; failed: number } | null;
};

const toCount = (value: unknown) => {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
};

async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const { redisBestEffortCommandClient: redis } = await import("./redis.js");
  if (redis.status === "ready") {
    try {
      const hit = await redis.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch {}
  }
  const value = await load();
  if (redis.status === "ready") {
    redis.set(key, JSON.stringify(value), "EX", ttlSeconds).catch(() => undefined);
  }
  return value;
}

async function loadAppCounts(spaceId: string) {
  const [row] = await db
    .select({
      count: sql<string>`count(distinct ${apps.id})`,
      likes: sql<string>`coalesce(sum(${resourceLikeCounts.likeCount}), 0)`,
    })
    .from(apps)
    .leftJoin(
      resourceLikeCounts,
      and(eq(resourceLikeCounts.resourceType, "app"), eq(resourceLikeCounts.resourceId, apps.id)),
    )
    .where(eq(apps.spaceId, spaceId));
  return { count: toCount(row?.count), likes: toCount(row?.likes) };
}

function loadAppViews(spaceId: string) {
  return cached(`api:space-overview:views:${spaceId}`, VIEWS_CACHE_TTL_SECONDS, async () => {
    const [row] = await db
      .select({ views: sql<string>`coalesce(sum(${appViewStatsHourly.viewCount}), 0)` })
      .from(appViewStatsHourly)
      .innerJoin(apps, eq(apps.id, appViewStatsHourly.appId))
      .where(eq(apps.spaceId, spaceId));
    return toCount(row?.views);
  });
}

function sumPaidOrdersUsd(
  orders: ReadonlyArray<{ paid_amount_snapshot: number; refunded_amount: number; currency_snapshot: string }>,
) {
  let minor = 0;
  for (const order of orders) {
    if (order.currency_snapshot.toUpperCase() !== "USD") continue;
    minor += Math.max(0, (order.paid_amount_snapshot || 0) - (order.refunded_amount || 0));
  }
  return minor;
}

const revenueInFlight = new Map<string, Promise<SpaceOverviewRevenue | null>>();

function loadRevenue(spaceId: string): Promise<SpaceOverviewRevenue | null> {
  const existing = revenueInFlight.get(spaceId);
  if (existing) return existing;
  const request = cached(`api:space-overview:revenue:${spaceId}`, REVENUE_CACHE_TTL_SECONDS, async () => {
    const businessKey = await getSpaceCommerceBusinessKey(spaceId);
    if (!businessKey) return null;
    const sdk = await createSpaceCommerceSdk();
    let minor = 0;
    for (let page = 1; page <= REVENUE_MAX_PAGES; page += 1) {
      const result = await sdk.admin.orders.list({
        business_key: businessKey,
        status: "paid",
        include_count: false,
        page,
        limit: REVENUE_PAGE_LIMIT,
      });
      minor += sumPaidOrdersUsd(result.items);
      if (!result.pagination.has_more) return { usd: minor / 100, partial: false };
    }
    return { usd: minor / 100, partial: true };
  })
    .catch((error) => {
      logger.warn("[space-overview] revenue unavailable", { spaceId, error });
      return null;
    })
    .finally(() => revenueInFlight.delete(spaceId));
  revenueInFlight.set(spaceId, request);
  return request;
}

function withinRevenueWait(request: Promise<SpaceOverviewRevenue | null>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), REVENUE_WAIT_MS);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

async function loadSchedules(spaceId: string, now: Date) {
  const since = new Date(now.getTime() - SPACE_OVERVIEW_DAYS * DAY_MS);
  const [[jobs], [runs]] = await Promise.all([
    db
      .select({ active: sql<string>`count(*) filter (where ${cronJobs.enabled})` })
      .from(cronJobs)
      .where(and(eq(cronJobs.spaceId, spaceId), isNull(cronJobs.deletedAt))),
    // Joining through cron_jobs keeps the scan on the (cron_job_id, created_at) index.
    db
      .select({
        runs: sql<string>`count(*)`,
        failed: sql<string>`count(*) filter (where ${taskRuns.status} = 'failed')`,
      })
      .from(taskRuns)
      .innerJoin(cronJobs, eq(cronJobs.id, taskRuns.cronJobId))
      .where(and(
        eq(cronJobs.spaceId, spaceId),
        gte(taskRuns.createdAt, since),
        inArray(taskRuns.status, ["completed", "failed"]),
      )),
  ]);
  return { active: toCount(jobs?.active), runs: toCount(runs?.runs), failed: toCount(runs?.failed) };
}

export async function loadSpaceOverview(input: {
  spaceId: string;
  includeRevenue: boolean;
  includeSchedules: boolean;
  now?: Date;
}): Promise<SpaceOverview> {
  const { spaceId } = input;
  const [counts, views, revenue, schedules] = await Promise.all([
    loadAppCounts(spaceId),
    loadAppViews(spaceId),
    input.includeRevenue ? withinRevenueWait(loadRevenue(spaceId)) : null,
    input.includeSchedules ? loadSchedules(spaceId, input.now ?? new Date()) : null,
  ]);
  return {
    days: SPACE_OVERVIEW_DAYS,
    apps: { ...counts, views, revenue },
    schedules,
  };
}
