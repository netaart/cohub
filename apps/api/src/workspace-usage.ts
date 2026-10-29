import { spaceWorkspaceUsage } from "@cohub/db";
import { createBullmqQueue } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import { toWorkspaceUsage, WORKSPACE_USAGE_QUEUE, type WorkspaceUsage } from "@cohub/protocol";
import { eq, sql } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";

const logger = createLogger({ serviceName: "cohub-api" });

/** Exposed for queue metrics only; scans are enqueued by the system worker. */
export const workspaceUsageQueue = createBullmqQueue(WORKSPACE_USAGE_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-workspace-usage",
});

/**
 * Stored measurement only: API reads never touch NAS. Null until a scan has
 * been attempted, so deployments that never scan (no pdu) show nothing.
 */
export async function readWorkspaceUsage(
  spaceId: string,
  sandbox: { provider: string; status: string; stoppedAt: Date | null } | null,
): Promise<WorkspaceUsage | null> {
  if (sandbox?.provider === "local") return null;
  const [row] = await db.select().from(spaceWorkspaceUsage).where(eq(spaceWorkspaceUsage.spaceId, spaceId)).limit(1);
  if (!row?.attemptedAt) return null;
  return toWorkspaceUsage(row, sandbox);
}

/**
 * Direct volume writes happen while the sandbox is down; the next sweep re-measures.
 * Every write is marked on the database clock after it completes, so any write
 * that finishes after a scan's claim is newer than that measurement.
 */
export function markWorkspaceChanged(spaceId: string) {
  const now = sql`date_trunc('milliseconds', clock_timestamp())`;
  void db.insert(spaceWorkspaceUsage).values({ spaceId, changedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: spaceWorkspaceUsage.spaceId, set: { changedAt: now, updatedAt: now } })
    .catch((error) => logger.warn(`[WorkspaceUsage] change marker failed spaceId=${spaceId}`, error));
}
