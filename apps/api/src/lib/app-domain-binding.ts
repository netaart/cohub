import { appDomains } from "@cohub/db";
import { APP_DOMAIN_EXCLUSIVE_STATUSES } from "@cohub/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";

export type CustomDomainBinding = { appId: string; active: boolean };

export async function readCustomDomainBinding(hostname: string): Promise<CustomDomainBinding | null> {
  const [row] = await db
    .select({ appId: appDomains.appId, status: appDomains.status })
    .from(appDomains)
    .where(and(eq(appDomains.hostname, hostname), inArray(appDomains.status, [...APP_DOMAIN_EXCLUSIVE_STATUSES])))
    .limit(1);
  return row ? { appId: row.appId, active: row.status === "active" } : null;
}
