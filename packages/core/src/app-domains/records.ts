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
    priceUsd: APP_DOMAIN_PRICE_USD,
    charged: row.billingClaimedAt !== null,
  };
}

export const appDomainOriginCacheKey = (hostname: string) => `app-origin:${hostname}`;
export const appDomainRefreshKey = (domainId: string) => `app-domain:refresh:${domainId}`;
export const appDomainCheckJobId = (domainId: string) => `app-domain-${domainId}`;
