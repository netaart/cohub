export const WORKSPACE_USAGE_QUEUE = "cohub-workspace-usage";
export const WORKSPACE_USAGE_SWEEP_JOB = "workspace_usage.sweep";
export const WORKSPACE_USAGE_UPDATED_EVENT = "space.workspace_usage.updated";

/** Allocated bytes of a cloud workspace, as of the start of the last successful scan. */
export type WorkspaceUsage = {
  bytes: number | null;
  measuredAt: string | null;
  status: "pending" | "ready" | "stale" | "error";
};

type DateLike = Date | string | null | undefined;

const time = (value: DateLike) => (value ? new Date(value).getTime() : Number.NaN);
const iso = (value: DateLike) => (value ? new Date(value).toISOString() : null);

const IDLE_SANDBOX_STATUSES: ReadonlySet<string> = new Set(["stopped", "terminated"]);

export function isSandboxIdleForWorkspaceUsage(status: string | null | undefined) {
  return !status || IDLE_SANDBOX_STATUSES.has(status);
}

export function toWorkspaceUsage(
  row: { bytes: number | null; measuredAt: DateLike; changedAt: DateLike; error: string | null } | null | undefined,
  sandbox: { status: string; stoppedAt: DateLike } | null | undefined,
): WorkspaceUsage {
  const measuredAt = time(row?.measuredAt);
  const measured = row?.bytes != null && Number.isFinite(measuredAt);
  const changed = !isSandboxIdleForWorkspaceUsage(sandbox?.status)
    || time(sandbox?.stoppedAt) > measuredAt
    || time(row?.changedAt) > measuredAt;
  return {
    bytes: measured ? row.bytes : null,
    measuredAt: measured ? iso(row.measuredAt) : null,
    status: row?.error ? "error" : !measured ? "pending" : changed ? "stale" : "ready",
  };
}

const STATUSES: ReadonlySet<unknown> = new Set(["pending", "ready", "stale", "error"]);

export function isWorkspaceUsage(value: unknown): value is WorkspaceUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return (usage.bytes === null || (typeof usage.bytes === "number" && Number.isSafeInteger(usage.bytes) && usage.bytes >= 0))
    && (usage.measuredAt === null || typeof usage.measuredAt === "string")
    && STATUSES.has(usage.status);
}
