import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { spaceSandboxes } from "@cohub/db";
import {
  createAgentTurnsQueue,
  enqueueAgentSandboxFsMutationJob,
  type AgentSandboxFsMutationJobData,
  type AgentSandboxFsMutationJobResult,
} from "@cohub/infra/agent-queue";
import { createLogger } from "@cohub/infra/logging";
import { isSandboxDialable } from "@cohub/sandbox-controller";
import { getAgentQueueEvents } from "./agent-queue-events.js";
import { config } from "./config.js";
import { db } from "./db.js";

const logger = createLogger({ serviceName: "cohub-worker" });

const RECONCILE_WAIT_MS = 30_000;

export type SandboxReconcileDeps = {
  isSandboxDialable(spaceId: string): Promise<boolean>;
  reconcileSandbox(spaceId: string): Promise<void>;
};

let agentQueue: ReturnType<typeof createAgentTurnsQueue<AgentSandboxFsMutationJobData, AgentSandboxFsMutationJobResult>> | null = null;

function getAgentQueue() {
  agentQueue ??= createAgentTurnsQueue<AgentSandboxFsMutationJobData, AgentSandboxFsMutationJobResult>(config.bullmqRedisUrl, "cohub-worker-sandbox-reconcile");
  return agentQueue;
}

const sandboxReconcileDeps: SandboxReconcileDeps = {
  async isSandboxDialable(spaceId) {
    const [sandbox] = await db
      .select({ status: spaceSandboxes.status, meta: spaceSandboxes.meta })
      .from(spaceSandboxes)
      .where(eq(spaceSandboxes.spaceId, spaceId))
      .limit(1);
    return isSandboxDialable(sandbox);
  },
  async reconcileSandbox(spaceId) {
    const job = await enqueueAgentSandboxFsMutationJob(getAgentQueue(), {
      spaceId,
      mutationId: randomUUID(),
      mutation: { operation: "reconcile" },
    });
    // A late reconcile is harmless, so a job still queued after the wait is left to run.
    const result = await job.waitUntilFinished(await getAgentQueueEvents(), RECONCILE_WAIT_MS) as AgentSandboxFsMutationJobResult;
    if (!result.ok) throw new Error(`sandbox reconcile failed: ${result.code}: ${result.message}`);
  },
};

/**
 * Runs a write that lands on the workspace volume directly, unseen by a
 * running sandbox's watcher and workspace index. Sandboxes start indexing
 * only after the API sees them as ready, so a write that finishes while none
 * is dialable is covered by that first reconcile; one that became dialable
 * meanwhile may already have indexed past the write and is told to reconcile.
 * The API applies the same fence to its direct writes.
 */
export async function runDirectWorkspaceWrite<T>(
  spaceId: string,
  write: () => Promise<T>,
  deps: SandboxReconcileDeps = sandboxReconcileDeps,
): Promise<T> {
  try {
    return await write();
  } finally {
    await reconcileSandboxAfterDirectWrite(spaceId, deps);
  }
}

async function reconcileSandboxAfterDirectWrite(spaceId: string, deps: SandboxReconcileDeps) {
  try {
    if (!(await deps.isSandboxDialable(spaceId))) return;
    await deps.reconcileSandbox(spaceId);
  } catch (error) {
    // The write's own outcome stands; the sandbox index may miss it until its next reconcile.
    logger.error(`[SandboxReconcile] reconcile after a direct workspace write failed spaceId=${spaceId}`, error);
  }
}
