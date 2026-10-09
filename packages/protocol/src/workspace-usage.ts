export const WORKSPACE_USAGE_SCAN_JOB = "workspace.usage.scan";
export const WORKSPACE_USAGE_DISPATCH_JOB = "workspace.usage.dispatch";
export const WORKSPACE_USAGE_DISPATCH_SCHEDULER_ID = "workspace-usage-dispatch";
export const WORKSPACE_USAGE_DISPATCH_INTERVAL_MS = 60_000;
export const WORKSPACE_USAGE_UPDATED_EVENT = "space.workspace.usage.updated";

/** Delayed measurement of allocated bytes, with hardlinks deduplicated per workspace. */
export type WorkspaceUsage = {
  bytes: number | null;
  measuredAt: string | null;
  status: "pending" | "ready" | "stale" | "error";
};

const WORKSPACE_USAGE_STATUSES: ReadonlySet<unknown> = new Set(["pending", "ready", "stale", "error"]);

/** Narrows realtime payloads, which are typed as unknown on the wire. */
export function isWorkspaceUsage(value: unknown): value is WorkspaceUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return (usage.bytes === null || (typeof usage.bytes === "number" && Number.isSafeInteger(usage.bytes) && usage.bytes >= 0))
    && (usage.measuredAt === null || typeof usage.measuredAt === "string")
    && WORKSPACE_USAGE_STATUSES.has(usage.status);
}
