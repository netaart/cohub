import { randomBytes } from "node:crypto";
import type { appDomains } from "@cohub/db";
import {
  APP_DOMAIN_PRICE_USD,
  appDomainChallengeName,
  appDomainChallengeValue,
  type AppDomainErrorCode,
  type AppDomainRecord,
  type AppDomainStatus,
} from "@cohub/protocol";

export type AppDomainRow = typeof appDomains.$inferSelect;

export function createAppDomainToken(): string {
  return randomBytes(16).toString("hex");
}

export function serializeAppDomain(row: AppDomainRow, cnameTarget: string): AppDomainRecord {
  return {
    id: row.id,
    appId: row.appId,
    spaceId: row.spaceId,
    hostname: row.hostname,
    url: `https://${row.hostname}`,
    status: row.status as AppDomainStatus,
    dnsRecords: [
      {
        type: "CNAME",
        name: row.hostname,
        value: cnameTarget,
        purpose: "routing",
        satisfied: row.providerStatus === "active" ? true : row.providerStatus === "moved" ? false : null,
      },
      {
        type: "TXT",
        name: appDomainChallengeName(row.hostname),
        value: appDomainChallengeValue(row.verificationToken),
        purpose: "ownership",
        satisfied: row.verifiedAt ? true : row.lastCheckedAt ? false : null,
      },
    ],
    certificateStatus: row.certificateStatus,
    error: row.errorCode
      ? { code: row.errorCode as AppDomainErrorCode, message: row.errorMessage ?? row.errorCode }
      : null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    priceUsd: APP_DOMAIN_PRICE_USD,
    charged: row.billingClaimedAt !== null,
  };
}

export const appDomainOriginCacheKey = (hostname: string) => `app-origin:${hostname}`;
/** Bumped on every invalidation so a lookup that started earlier cannot refill the cache. */
export const appDomainOriginGenerationKey = (hostname: string) => `app-origin-gen:${hostname}`;

type OriginCacheRedis = {
  multi(): { incr(key: string): unknown; expire(key: string, seconds: number): unknown; del(key: string): unknown; exec(): Promise<unknown> };
};

export async function invalidateAppDomainOriginCache(redis: OriginCacheRedis, hostname: string) {
  const multi = redis.multi();
  multi.incr(appDomainOriginGenerationKey(hostname));
  multi.expire(appDomainOriginGenerationKey(hostname), 24 * 60 * 60);
  multi.del(appDomainOriginCacheKey(hostname));
  await multi.exec();
}
export const appDomainRefreshKey = (domainId: string) => `app-domain:refresh:${domainId}`;
export const appDomainCheckJobId = (domainId: string) => `app-domain-${domainId}`;
/**
 * A request that arrived while the regular job was running gets its own job,
 * queued before the API returns, so no handoff can lose it.
 */
export const appDomainRequestJobId = (domainId: string, requestedAt: number) =>
  `app-domain-${domainId}-request-${requestedAt}-${randomBytes(4).toString("hex")}`;
export const APP_DOMAIN_REQUEST_DELAY_MS = 2_000;
/** Redis-clock ms when the latest regular pass started. */
export const appDomainRegularStartedKey = (domainId: string) => `app-domain:regular-started:${domainId}`;

/** Milliseconds on the Redis server clock, shared by API and worker pods. */
export async function redisNowMs(redis: { time(): Promise<ReadonlyArray<string | number>> }) {
  const [seconds = 0, micros = 0] = await redis.time();
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}
