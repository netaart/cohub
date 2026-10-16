import { UnrecoverableError } from "bullmq";
import { getPromptAuthScopes, type PromptAuthContext } from "@cohub/core/sessions";
import { hasPermission, normalizePermissionScopes, scopeListHasPermission, type Permission, type PermissionStore } from "@cohub/core/permissions";

/**
 * Resolves everything a delegated app authorization may do on a space, from
 * server state only — the payload's scope snapshot is never consulted.
 */
export type LiveScopeResolver = (input: {
  appId: string;
  grantId?: string;
  viewerUserUuid: string;
  spaceId: string;
}) => Promise<{ appScopes: Permission[]; viewerScopes: Permission[] }>;

export async function assertTaskPromptAccess(
  input: { spaceId: string; sessionId?: string | null; userId: string; promptPermission: Permission; auth: PromptAuthContext | null },
  store: PermissionStore,
): Promise<void> {
  if (input.sessionId && await store.getSessionSpaceId(input.sessionId) !== input.spaceId) {
    throw new UnrecoverableError("Scheduled session does not belong to this space.");
  }
  if (input.auth && scopeListHasPermission(getPromptAuthScopes(input.auth, input.spaceId), input.promptPermission)) return;
  if (input.auth || !(await hasPermission({
    store,
    user: { uuid: input.userId },
    permission: input.promptPermission,
    context: { spaceId: input.spaceId, sessionId: input.sessionId ?? undefined },
  }))) {
    throw new UnrecoverableError("Prompt permission is no longer available for this task.");
  }
}

/**
 * Re-validates delegated app auth before a delayed prompt runs, before any
 * side effect:
 *
 * - No auth at all is a plain user task and passes through.
 * - Auth that does not match this task (wrong type, source, space, or actor)
 *   is unrecoverable — it was submitted under app authorization and must not
 *   silently degrade into an unauthenticated prompt.
 * - App-origin auth is a *reference*, not a snapshot: the stored payload is
 *   editable (cron jobs), so scopes are resolved from server state at
 *   execution time — the app's live side scopes plus the viewer's live grant,
 *   intersected with the viewer's current access. Expired, revoked, or
 *   downgraded authorizations abort the task instead of creating a session
 *   and spending the viewer's quota.
 */
export async function sanitizeTaskPromptAuth(
  auth: PromptAuthContext | null | undefined,
  input: { spaceId: string; userId: string; promptPermission: Permission },
  resolveLive: LiveScopeResolver,
): Promise<PromptAuthContext | null> {
  if (!auth) return null;
  if (
    auth.type !== "delegated_prompt" ||
    auth.source !== "app_session" ||
    !auth.appId ||
    auth.spaceId !== input.spaceId ||
    auth.actorUserId !== input.userId
  ) {
    throw new UnrecoverableError("Prompt authorization does not match this task.");
  }
  const { appScopes, viewerScopes } = await resolveLive({
    appId: auth.appId,
    ...(auth.appViewerGrantId ? { grantId: auth.appViewerGrantId } : {}),
    viewerUserUuid: auth.actorUserId,
    spaceId: input.spaceId,
  });
  const sanitized: PromptAuthContext = {
    ...auth,
    appScopes,
    viewerScopes,
    scopes: normalizePermissionScopes([...appScopes, ...viewerScopes]),
    // Fresh as of this re-validation — the execution-time reference, not the
    // long-expired submission token.
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const liveScopes = getPromptAuthScopes(sanitized, input.spaceId);
  if (liveScopes.length === 0 || !scopeListHasPermission(liveScopes, input.promptPermission)) {
    throw new UnrecoverableError("Prompt authorization is no longer active for this task.");
  }
  return sanitized;
}
