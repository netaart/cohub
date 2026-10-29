import { spaceWorkspaceUsage } from "@cohub/db";
import { createBullmqQueue } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import { toWorkspaceUsage, WORKSPACE_USAGE_QUEUE, type WorkspaceUsage } from "@cohub/protocol";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";

const logger = createLogger({ serviceName: "cohub-api" });

/** Exposed for queue metrics only; scans are enqueued by the system worker. */
export const workspaceUsageQueue = createBullmqQueue(WORKSPACE_USAGE_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-workspace-usage",
});

/** Stored measurement only: API reads never touch NAS. */
export async function readWorkspaceUsage(
  spaceId: string,
  sandbox: { provider: string; status: string; stoppedAt: Date | null } | null,
): Promise<WorkspaceUsage | null> {
  if (sandbox?.provider === "local") return null;
  const [row] = await db.select().from(spaceWorkspaceUsage).where(eq(spaceWorkspaceUsage.spaceId, spaceId)).limit(1);
  return toWorkspaceUsage(row, sandbox);
}

// The sweep waits 10 quiet minutes after changedAt and measures from scan start,
// so a marker up to a minute old still covers every write.
const MARK_THROTTLE_MS = 60_000;
const lastMarked = new Map<string, number>();

/** Direct volume writes happen while the sandbox is down; the next sweep re-measures. */
export function markWorkspaceChanged(spaceId: string) {
  const now = new Date();
  if (now.getTime() - (lastMarked.get(spaceId) ?? 0) < MARK_THROTTLE_MS) return;
  if (lastMarked.size > 10_000) lastMarked.clear();
  lastMarked.set(spaceId, now.getTime());
  void db.insert(spaceWorkspaceUsage).values({ spaceId, changedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: spaceWorkspaceUsage.spaceId, set: { changedAt: now, updatedAt: now } })
    .catch((error) => logger.warn(`[WorkspaceUsage] change marker failed spaceId=${spaceId}`, error));
}
