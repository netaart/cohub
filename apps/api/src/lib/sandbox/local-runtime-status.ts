import { spaceSandboxes } from "@cohub/db";
import { and, eq } from "drizzle-orm";
import { runtimeWorkspaceSchema } from "@cohub/protocol";
import type { db } from "../../db/index.js";

export type LocalRuntimeStatusReport = {
  spaceId: string;
  status: "ready" | "stopped";
  runtimeId?: string | null;
  connectionId?: string;
  wsEndpoint?: string | null;
  hostname?: string | null;
  gatewayNodeId?: string | null;
};

/** Serialize reports before checking the existing lease, not after it. No clock or generation ordering. */
export async function reportLocalRuntimeStatus(database: Pick<typeof db, "transaction">, report: LocalRuntimeStatusReport, readLease: () => Promise<string | null>) {
  return database.transaction(async (tx) => {
    const [sandbox] = await tx.select().from(spaceSandboxes)
      .where(and(eq(spaceSandboxes.spaceId, report.spaceId), eq(spaceSandboxes.provider, "local")))
      .for("update").limit(1);
    if (!sandbox) return false;
    const meta = (sandbox.meta as Record<string, unknown> | null) ?? {};
    const ready = report.status === "ready";
    if (ready) {
      // Bound time holding the row lock, including a Redis outage/offline queue.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let raw: string | null;
      try {
        raw = await Promise.race([
          readLease(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Runtime lease lookup timed out")), 3000); }),
        ]);
      } finally { clearTimeout(timer); }
      const lease = runtimeWorkspaceSchema.safeParse(raw ? JSON.parse(raw) : null);
      if (!lease.success || lease.data.connectionId !== report.connectionId || lease.data.runtimeId !== report.runtimeId) return true;
    } else if ((meta.runtimeConnectionId ?? null) !== (report.connectionId ?? null)) {
      return true;
    }
    const now = new Date();
    await tx.update(spaceSandboxes).set({
      status: ready ? "ready" : "stopped",
      runtimeStatus: ready ? "ready" : "error",
      updatedAt: now,
      ...(ready ? { reportedAt: now, lastHeartbeatAt: now, lastActivityAt: now } : {}),
      stoppedAt: ready ? null : now,
      stopReason: ready ? null : "disconnected",
      meta: ready ? {
        ...meta, kind: "local", wsEndpoint: report.wsEndpoint?.trim() || null,
        hostname: report.hostname ?? null, gatewayNodeId: report.gatewayNodeId ?? null,
        runtimeId: report.runtimeId ?? null, runtimeConnectionId: report.connectionId,
      } : { ...meta, wsEndpoint: null },
    }).where(eq(spaceSandboxes.spaceId, report.spaceId));
    return true;
  });
}
