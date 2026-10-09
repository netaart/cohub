import type { WorkspaceUsage } from "@cohub/protocol";
import { getWorkspaceUsage, parseWorkspaceUsage } from "@cohub/infra/workspace-usage";
import { config } from "./config.js";
import { redisBestEffortCommandClient } from "./redis.js";

/** Cached summary only: API reads never traverse NAS or start a sandbox. */
export async function readWorkspaceUsage(spaceId: string): Promise<WorkspaceUsage> {
  return getWorkspaceUsage(redisBestEffortCommandClient, config.env, spaceId)
    .catch(() => parseWorkspaceUsage({}));
}
