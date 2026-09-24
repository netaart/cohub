import type { WorkspaceUsage } from "@cohub/protocol";
import { getWorkspaceUsages, parseWorkspaceUsage } from "@cohub/infra/workspace-usage";
import { config } from "./config.js";
import { redisBestEffortCommandClient } from "./redis.js";

/** Cached summary only: API reads never traverse NAS or start a sandbox. */
export async function readWorkspaceUsages(ids: string[]): Promise<Map<string, WorkspaceUsage>> {
  if (!ids.length) return new Map();
  return getWorkspaceUsages(redisBestEffortCommandClient, config.env, ids)
    .catch(() => new Map(ids.map((id) => [id, parseWorkspaceUsage({})])));
}
