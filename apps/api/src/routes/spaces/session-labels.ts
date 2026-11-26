import { createLogger } from "@cohub/infra/logging";
import type { Context } from "hono";
import { db } from "../../db/index.js";
import { authzDenied } from "../../lib/middleware.js";
import { assignLabelsToSession, parseLabelRefs, resolveLabelPaths, resolveOrCreateLabelPaths } from "@cohub/core/labels";
import { hasPermission } from "../../permissions.js";
import type { AuthUser } from "../../lib/middleware.js";
import { dispatchLabelAssignmentsUpdated } from "../../realtime-events.js";

const logger = createLogger({ serviceName: "cohub-api" });

export async function resolveLabelRefIds(c: Context, user: AuthUser, spaceId: string, sessionId: string | null, labelRefs: unknown): Promise<string[] | Response> {
  try {
    const paths = parseLabelRefs(labelRefs);
    if (paths.length === 0) return [];
    if (!(await hasPermission(user, "space.label.assign", sessionId ? { spaceId, sessionId } : { spaceId }))) return authzDenied(c);
    const resolved = await resolveLabelPaths({ db, spaceId, paths });
    if (resolved.missingPaths.length > 0 && !(await hasPermission(user, "space.label.manage", { spaceId }))) return authzDenied(c);
    return (await resolveOrCreateLabelPaths({ db, spaceId, paths, userId: user.uuid })).labelIds;
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
}

export async function applySessionLabels(input: { spaceId: string; sessionId: string; labelIds: string[]; userId: string }) {
  const { spaceId, sessionId } = input;
  if (input.labelIds.length === 0) return;
  await assignLabelsToSession({ db, spaceId, sessionId, labelIds: input.labelIds, userId: input.userId });
  await dispatchLabelAssignmentsUpdated({ spaceId, resourceType: "session", resourceRef: sessionId, sessionId }).catch((error) => {
    logger.warn("[SessionLabels] failed to dispatch requested labels", error);
  });
}
