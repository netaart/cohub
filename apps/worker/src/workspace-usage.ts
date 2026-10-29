import { spaceWorkspaceUsage } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { sql } from "drizzle-orm";
import { db } from "./db.js";

const logger = createLogger({ serviceName: "cohub-worker" });

/** Best effort: a missed marker leaves the old value until the sandbox next stops. */
export async function markWorkspaceChanged(spaceId: string) {
  const now = sql`date_trunc('milliseconds', clock_timestamp())`;
  await db.insert(spaceWorkspaceUsage).values({ spaceId, changedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: spaceWorkspaceUsage.spaceId, set: { changedAt: now, updatedAt: now } })
    .catch((error) => logger.warn(`[WorkspaceUsage] change marker failed spaceId=${spaceId}`, error));
}
