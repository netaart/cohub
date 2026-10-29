import { spaceWorkspaceUsage } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { db } from "./db.js";

const logger = createLogger({ serviceName: "cohub-worker" });

/** Best effort: a missed marker only delays the next scan until recalibration. */
export async function markWorkspaceChanged(spaceId: string) {
  const now = new Date();
  await db.insert(spaceWorkspaceUsage).values({ spaceId, changedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: spaceWorkspaceUsage.spaceId, set: { changedAt: now, updatedAt: now } })
    .catch((error) => logger.warn(`[WorkspaceUsage] change marker failed spaceId=${spaceId}`, error));
}
