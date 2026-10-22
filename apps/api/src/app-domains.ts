import { randomUUID } from "node:crypto";
import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import {
  APP_DOMAIN_REQUEST_DELAY_MS,
  appDomainCheckJobId,
  appDomainRequestJobId,
  appDomainOriginCacheKey,
  appDomainOriginGenerationKey,
  invalidateAppDomainOriginCache,
  redisNowMs,
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
  APP_DOMAIN_EXCLUSIVE_STATUSES,
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

export type CustomDomainBinding = { appId: string; active: boolean };

const FILL_IF_GENERATION_SCRIPT = `if (redis.call("get", KEYS[2]) or "0") == ARGV[1] then return redis.call("set", KEYS[1], ARGV[2], "EX", ARGV[3]) end return 0`;

async function readCustomDomainBinding(hostname: string): Promise<CustomDomainBinding | null> {
  const [row] = await db
    .select({ appId: appDomains.appId, status: appDomains.status })
    .from(appDomains)
    .where(and(eq(appDomains.hostname, hostname), inArray(appDomains.status, [...APP_DOMAIN_EXCLUSIVE_STATUSES])))
    .limit(1);
  return row ? { appId: row.appId, active: row.status === "active" } : null;
}

/**
 * The App holding a custom domain (provisioning, active or being removed), or
 * null when the host is unbound. `fresh` skips the cache for authorization
 * decisions; otherwise the answer is cached briefly, and a lookup that raced
 * an invalidation never writes its result back.
 */
export async function resolveCustomDomainBinding(
  hostname: string,
  options: { fresh?: boolean } = {},
): Promise<CustomDomainBinding | null> {
  if (options.fresh) return readCustomDomainBinding(hostname);
  const key = appDomainOriginCacheKey(hostname);
  const generationKey = appDomainOriginGenerationKey(hostname);
  const [cached, generation] = await redisCommandClient.mget(key, generationKey).catch(() => [null, null]);
  if (cached !== null && cached !== undefined) {
    return cached ? { appId: cached.slice(2), active: cached.startsWith("a:") } : null;
  }
  const binding = await readCustomDomainBinding(hostname);
  await redisCommandClient
    .eval(
      FILL_IF_GENERATION_SCRIPT,
      2,
      key,
      generationKey,
      generation ?? "0",
      binding ? `${binding.active ? "a" : "b"}:${binding.appId}` : "",
      binding ? ORIGIN_CACHE_TTL_SECONDS : ORIGIN_MISS_CACHE_TTL_SECONDS,
    )
    .catch(() => undefined);
  return binding;
}

export async function invalidateAppDomainOrigin(hostname: string) {
  await invalidateAppDomainOriginCache(redisCommandClient, hostname).catch((error) =>
    logger.warn("[app-domains] failed to invalidate origin cache", { hostname, error }));
}

/**
 * Runs a check that sees the caller's change. A delayed regular job is pulled
 * forward and a waiting one has not read the row yet; a running one may have,
 * so the change gets its own one-off job.
 */
export async function enqueueAppDomainCheck(domainId: string, delayMs = 0) {
  const delay = Math.max(0, delayMs);
  const options = { attempts: 3, backoff: { type: "exponential" as const, delay: 30_000 }, ...defaultJobRetention };
  const jobId = appDomainCheckJobId(domainId);
  const existing = await queue.getJob(jobId);
  if (!existing) {
    await queue.add(APP_DOMAIN_CHECK_JOB, { domainId }, { ...options, jobId, delay });
    return;
  }
  const state = await existing.getState().catch(() => null);
  if (state === "waiting") return;
  if (state === "delayed" && (await existing.changeDelay(delay).then(() => true, () => false))) return;
  if (state === "completed" || state === "failed") {
    // Reuse the fixed id only once the old job is certainly gone; a duplicate add would be a no-op.
    if (await existing.remove().then(() => true, () => false)) {
      await queue.add(APP_DOMAIN_CHECK_JOB, { domainId }, { ...options, jobId, delay });
      return;
    }
  }
  // Running, unreadable, or not re-armable: queue a distinct one-off job.
  const requestedAt = await redisNowMs(redisCommandClient);
  await queue.add(APP_DOMAIN_CHECK_JOB, { domainId, requestedAt }, {
    ...options,
    jobId: appDomainRequestJobId(domainId, requestedAt),
    delay: Math.max(APP_DOMAIN_REQUEST_DELAY_MS, delay),
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
        // Stop serving now; Cloudflare cleanup may take retries.
        await invalidateAppDomainOrigin(next.hostname);
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Releases an App's domains inside the App deletion transaction, which holds
 * the App row lock that domain creation also takes. Run the returned
 * follow-up after commit.
 */
export async function releaseAppDomainsInTransaction(tx: Tx, appId: string) {
  const rows = await tx.select().from(appDomains).where(eq(appDomains.appId, appId)).for("update");
  const deleted: AppDomainRow[] = [];
  const removing: AppDomainRow[] = [];
  for (const row of rows) {
    if (row.status === "pending" || row.status === "failed") {
      await tx.delete(appDomains).where(eq(appDomains.id, row.id));
      deleted.push(row);
      continue;
    }
    const [next] = await tx
      .update(appDomains)
      .set({ status: "removing", removalIntent: "user", updatedAt: new Date() })
      .where(eq(appDomains.id, row.id))
      .returning();
    if (next) removing.push(next);
  }
  return async () => {
    for (const row of deleted) await publishAppDomainRemoved(row, "removed");
    for (const row of removing) {
      await invalidateAppDomainOrigin(row.hostname);
      await publishAppDomainUpdated(row);
      await enqueueAppDomainCheck(row.id);
    }
  };
}

export function newAppDomainToken() {
  return { verificationToken: createAppDomainToken(), tokenIssuedAt: new Date() };
}
