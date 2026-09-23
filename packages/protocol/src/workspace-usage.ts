export const WORKSPACE_USAGE_SCAN_JOB = "workspace.usage.scan";
export const WORKSPACE_USAGE_DISPATCH_JOB = "workspace.usage.dispatch";
export const WORKSPACE_USAGE_UPDATED_EVENT = "space.workspace.usage.updated";

/** Delayed measurement of allocated bytes, with hardlinks deduplicated per workspace. */
export type WorkspaceUsage = {
  bytes: number | null;
  measuredAt: string | null;
  status: "pending" | "ready" | "stale" | "error";
};
