import type { Permission } from "@neta-art/cohub";
import type { TaskBrowserScope } from "./scope.ts";

export type AccessRequest = {
  scopes: Permission[];
  reason: string;
  spaceId?: string;
};

/**
 * Viewer grants are per Space: browsing a Space (or one of its sessions) asks
 * for `taskrun.view` on that Space, while "Mine" asks for the account-level
 * `user.taskrun.list` so the viewer sees every run they own.
 */
export function accessRequestFor(scope: TaskBrowserScope): AccessRequest {
  if (scope.kind === "mine") {
    return {
      scopes: ["user.taskrun.list"],
      reason: "List every generation task you own across your spaces.",
    };
  }
  return {
    scopes: ["taskrun.view"],
    spaceId: scope.spaceId,
    reason: "View generation tasks in the space you opened this app from.",
  };
}
