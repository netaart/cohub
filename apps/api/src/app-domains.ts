import { randomUUID } from "node:crypto";
import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import {
  appDomainCheckJobId,
  appDomainOriginCacheKey,
  appDomainRefreshKey,
  createAppDomainBilling,
  createAppDomainToken,
  serializeAppDomain,
  type AppDomainRow,
} from "@cohub/core/app-domains";
import { appDomains } from "@cohub/db";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import {
  APP_DOMAIN_CHECK_JOB,
  isHostnameWithin,
  type AppDomainCheckJobData,
  type AppDomainRemovedReason,
} from "@cohub/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { redisCommandClient } from "./redis.js";
import { dispatchSpaceDomainEvent } from "./space-events.js";
import { spaceWalletBilling } from "./space-wallet-billing.js";

const logger = createLogger({ serviceName: "cohub-api" });
const ORIGIN_CACHE_TTL_SECONDS = 60;
const ORIGIN_MISS_CACHE_TTL_SECONDS = 30;
const REFRESH_REQUEST_TTL_SECONDS = 600;
const CHECK_COOLDOWN_SECONDS = 30;
/** A fresh token cannot be in DNS yet; give the user time to add it. */
export const APP_DOMAIN_FIRST_CHECK_DELAY_MS = 30_000;

const queue = createBullmqQueue<AppDomainCheckJobData>(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-app-domains",
});

export const appDomainBilling = createAppDomainBilling({
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  spaceWalletBilling,
});

export const toAppDomainRecord = (row: AppDomainRow) => serializeAppDomain(row, config.appCustomDomainCnameTarget);

/** Hostnames Cohub serves itself can never be bound as custom domains. */
export function isReservedAppDomain(hostname: string): boolean {
  const zones = [...config.sandboxPublicDomains, config.appCustomDomainCnameTarget.split(".").slice(1).join(".")];
  const template = config.appStandaloneHostTemplate;
  if (template) {
    const suffix = template.slice(template.indexOf("}") + 1);
    zones.push(suffix.slice(suffix.indexOf(".") + 1));
  }
  if (config.webOrigin) {
    try {
      zones.push(new URL(config.webOrigin).hostname);
    } catch {
      // Ignore an unparsable web origin.
    }
  }
  return zones.some((zone) => zone && isHostnameWithin(hostname, zone));
}

export function parseHttpsOriginHostname(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !url.port && url.origin === origin ? url.hostname : null;
  } catch {
    return null;
  }
}

/** The App behind an active custom domain; host-to-App mapping is cached briefly. */
export async function resolveCustomDomainAppId(hostname: string): Promise<string | null> {
  const key = appDomainOriginCacheKey(hostname);
  const cached = await redisCommandClient.get(key).catch(() => null);
  if (cached !== null) return cached || null;
  const [row] = await db
    .select({ appId: appDomains.appId })
    .from(appDomains)
    .where(and(eq(appDomains.hostname, hostname), eq(appDomains.status, "active")))
    .limit(1);
  const appId = row?.appId ?? null;
  await redisCommandClient
    .set(key, appId ?? "", "EX", appId ? ORIGIN_CACHE_TTL_SECONDS : ORIGIN_MISS_CACHE_TTL_SECONDS)
    .catch(() => undefined);
  return appId;
}

export async function invalidateAppDomainOrigin(hostname: string) {
  await redisCommandClient.del(appDomainOriginCacheKey(hostname)).catch(() => undefined);
}

/**
 * One check job per domain (fixed id). A delayed job is pulled forward, an
 * active one is left to finish (it re-reads the row), anything else re-added.
 */
export async function enqueueAppDomainCheck(domainId: string, delayMs = 0) {
  const jobId = appDomainCheckJobId(domainId);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState().catch(() => "unknown" as const);
    if (state === "delayed") {
      await existing.changeDelay(Math.max(0, delayMs));
      return;
    }
    if (state === "active" || state === "waiting") return;
    await existing.remove().catch(() => undefined);
  }
  await queue.add(APP_DOMAIN_CHECK_JOB, { domainId }, {
    jobId,
    delay: Math.max(0, delayMs),
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    ...defaultJobRetention,
  });
}

/** Asks the next check to restart Cloudflare validation. */
export async function requestAppDomainRefresh(domainId: string) {
  await redisCommandClient.set(appDomainRefreshKey(domainId), "1", "EX", REFRESH_REQUEST_TTL_SECONDS);
}

/** False while a manual check of this domain ran within the cooldown. */
export async function claimAppDomainCheck(domainId: string) {
  const result = await redisCommandClient
    .set(`app-domain:check-cooldown:${domainId}`, "1", "EX", CHECK_COOLDOWN_SECONDS, "NX")
    .catch(() => "OK");
  return result === "OK";
}

export async function publishAppDomainUpdated(row: AppDomainRow) {
  await dispatchSpaceDomainEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "app.domain.updated",
    spaceId: row.spaceId,
    sessionId: null,
    payload: { domain: toAppDomainRecord(row) },
  }).catch((error) => logger.warn("[app-domains] failed to publish update", { domainId: row.id, error }));
}

export async function publishAppDomainRemoved(row: AppDomainRow, reason: AppDomainRemovedReason) {
  await dispatchSpaceDomainEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "app.domain.removed",
    spaceId: row.spaceId,
    sessionId: null,
    payload: { appId: row.appId, domainId: row.id, hostname: row.hostname, reason },
  }).catch((error) => logger.warn("[app-domains] failed to publish removal", { domainId: row.id, error }));
}

/**
 * Unverified claims own no Cloudflare resource and are deleted outright.
 * Exclusive rows hand off to the check job, which deletes the Cloudflare
 * hostname first. Returns the row as it now stands, or null once deleted.
 */
export async function removeAppDomain(row: AppDomainRow): Promise<AppDomainRow | null> {
  let current: AppDomainRow | null = row;
  for (let attempt = 0; attempt < 3 && current; attempt += 1) {
    if (current.status === "pending" || current.status === "failed") {
      const deleted = await db
        .delete(appDomains)
        .where(and(eq(appDomains.id, current.id), inArray(appDomains.status, ["pending", "failed"])))
        .returning();
      if (deleted[0]) {
        await publishAppDomainRemoved(deleted[0], "removed");
        return null;
      }
    } else if (current.status === "removing" && current.removalIntent === "user") {
      await enqueueAppDomainCheck(current.id);
      return current;
    } else {
      const [next] = await db
        .update(appDomains)
        .set({ status: "removing", removalIntent: "user", updatedAt: new Date() })
        .where(and(eq(appDomains.id, current.id), eq(appDomains.status, current.status)))
        .returning();
      if (next) {
        await publishAppDomainUpdated(next);
        await enqueueAppDomainCheck(next.id);
        return next;
      }
    }
    current = (await db.select().from(appDomains).where(eq(appDomains.id, row.id)).limit(1))[0] ?? null;
  }
  if (current) throw new Error(`app domain ${row.id} changed concurrently; retry`);
  return null;
}

export async function releaseAppDomainsForApp(appId: string) {
  const rows = await db.select().from(appDomains).where(eq(appDomains.appId, appId));
  for (const row of rows) await removeAppDomain(row);
}

export function newAppDomainToken() {
  return { verificationToken: createAppDomainToken(), tokenIssuedAt: new Date() };
}
