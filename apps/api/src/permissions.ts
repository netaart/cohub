import { createBatchDrizzlePermissionStore, hasPermission as hasSharedPermission, intersectPermissionScopes, isUserLevelPermission, normalizeAppPublisherScopes, normalizePermissionScopes, resolvePermissionAccess as resolveSharedPermissionAccess, scopeListHasPermission } from "@cohub/core/permissions";
import { db } from "./db/index.js";
import type { AuthUserProfile } from "./auth.js";
import { apps, appViewerGrants, spaceMembers, spaces, type SpaceRole } from "@cohub/db";
import type { Permission, AccessPolicy, PermissionAccess } from "@cohub/core/permissions";
import type { PreviewSessionPrincipal } from "./preview-sessions.js";
import { hasPreviewSessionPermission } from "./preview-sessions.js";
import type { AppSessionPrincipal } from "./app-sessions.js";
import { and, eq } from "drizzle-orm";

type ResolvedAppState = { appScopes: Permission[] };

type CachedAppSessionPrincipal = AppSessionPrincipal & {
  activeAppState?: Promise<ResolvedAppState | null>;
  activeGrants?: Map<string, Promise<ResolvedViewerGrant | null>>;
  anySpaceGrants?: Promise<ResolvedViewerGrant[]>;
};

type ScopedExecutionPrincipal = {
  spaceId: string;
  scopes?: Permission[];
};

const permissionStore = createBatchDrizzlePermissionStore(db);

export type { Audience, Permission } from "@cohub/core/permissions";

export async function getSpaceMemberRole(spaceId: string, userId: string): Promise<SpaceRole | null> {
  return permissionStore.getSpaceMemberRole(spaceId, userId);
}

const getUserAppSession = (user: AuthUserProfile | null): CachedAppSessionPrincipal | null => {
  const session = (user as (AuthUserProfile & { appSession?: CachedAppSessionPrincipal }) | null)?.appSession;
  if (!session || user?.uuid !== session.userUuid) return null;
  return session;
};

const getUserExecution = (user: AuthUserProfile | null): ScopedExecutionPrincipal | null => {
  const execution = (user as (AuthUserProfile & { execution?: ScopedExecutionPrincipal }) | null)?.execution;
  if (!execution || !Array.isArray(execution.scopes)) return null;
  return execution;
};

const getUserPreviewSession = (user: AuthUserProfile | null): PreviewSessionPrincipal | null => {
  const session = (user as (AuthUserProfile & { previewSession?: PreviewSessionPrincipal }) | null)?.previewSession;
  if (!session || user?.uuid !== session.userUuid) return null;
  return session;
};

/**
 * Strip app-session/preview/execution principal scopes for account-level handlers
 * (`user.space.list` / `user.session.list` / `user.taskrun.list` /
 * `user.usage.read`).
 * Gate with the original principal; load data with this identity.
 */
export function asAccountIdentity(user: { uuid?: string | null } | null | undefined): { uuid: string } | null {
  const uuid = typeof user?.uuid === "string" ? user.uuid.trim() : "";
  return uuid ? { uuid } : null;
}

export function isTaskRunOwner(
  user: { uuid?: string | null } | null | undefined,
  run: { userUuid: string | null },
): boolean {
  return Boolean(user?.uuid && run.userUuid === user.uuid);
}

/**
 * Spaces whose Task Runs an app session may list: spaces with a live
 * `taskrun.view` viewer grant, re-validated against the viewer's current
 * access there. A grant on one Space never widens to the viewer's other
 * Spaces, and account-level (unscoped) runs stay invisible to apps.
 * Returns null for non-app principals; callers keep their own rules.
 */
export async function listAppSessionTaskRunSpaceIds(
  user: AuthUserProfile | null,
): Promise<string[] | null> {
  const appSession = getUserAppSession(user);
  if (!appSession) return null;
  if (!(await getActiveAppState(appSession))) return [];
  const grants = await getViewerGrantsForAnySpace(appSession);
  const candidates = grants
    .filter((grant) => scopeListHasPermission(grant.scopes, "taskrun.view"))
    .map((grant) => grant.spaceId);
  if (candidates.length === 0) return [];
  return permissionStore.filterSpaceIdsByPermission({
    user: { uuid: appSession.userUuid },
    permission: "taskrun.view",
    spaceIds: candidates,
  });
}

/**
 * Account-level Task Run view (`user.taskrun.list`): every run owned by the
 * viewer, including runs from spaces they can no longer access and unscoped
 * runs. Real users always have it; apps need an explicit viewer grant.
 */
export async function canViewOwnTaskRunsAccountWide(user: AuthUserProfile | null): Promise<boolean> {
  const appSession = getUserAppSession(user);
  if (!appSession) return Boolean(user?.uuid);
  return hasActiveViewerGrantPermission(appSession, "user.taskrun.list");
}

/**
 * The viewer's own accessible spaces: owned plus membership. Bounded by the
 * account's space count, never by its data volume — the basis for
 * account-level listings.
 */
export async function listAccessibleSpaceIds(userUuid: string): Promise<string[]> {
  const owned = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.userUuid, userUuid));
  const member = await db
    .select({ id: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, userUuid));
  return Array.from(new Set([...owned.map((item) => item.id), ...member.map((item) => item.id)]));
}

/**
 * Fallback for one Task Run detail under the account-level view: the
 * viewer's own run regardless of current Space access. Real users already
 * have this owner view; this helper only widens app sessions.
 */
export async function canViewTaskRunViaAccountScope(
  user: AuthUserProfile | null,
  run: { userUuid: string | null; spaceId: string | null },
): Promise<boolean> {
  if (!getUserAppSession(user) || !user?.uuid) return false;
  if (run.userUuid !== user.uuid) return false;
  return canViewOwnTaskRunsAccountWide(user);
}

/** Unscoped Task Runs are account-level: their owner, or an app with `user.taskrun.list`. */
export async function canAccessUnscopedTaskRun(
  user: AuthUserProfile | null,
  ownerUserUuid: string | null,
) {
  if (!user || ownerUserUuid !== user.uuid) return false;
  const appSession = getUserAppSession(user);
  if (!appSession) return true;
  return hasActiveViewerGrantPermission(appSession, "user.taskrun.list");
}

type ResolvedViewerGrant = {
  grantId: string;
  spaceId: string;
  scopes: Permission[];
};

const isGrantAlive = (grant: { revokedAt: Date | null; expiresAt: Date | null }) =>
  !grant.revokedAt && (!grant.expiresAt || grant.expiresAt.getTime() > Date.now());

/**
 * Resolves the viewer's live grant for one space by its natural key
 * (app + viewer + space). The grant row is the source of truth for consent;
 * the token carries no grant state.
 */
const loadViewerGrantForSpace = async (appId: string, viewerUserUuid: string, spaceId: string): Promise<ResolvedViewerGrant | null> => {
  const [grant] = await db
    .select()
    .from(appViewerGrants)
    .where(and(
      eq(appViewerGrants.appId, appId),
      eq(appViewerGrants.viewerUserUuid, viewerUserUuid),
      eq(appViewerGrants.spaceId, spaceId),
    ))
    .limit(1);
  if (!grant || !isGrantAlive(grant)) return null;
  return { grantId: grant.id, spaceId: grant.spaceId, scopes: normalizePermissionScopes(grant.scopes as string[]) };
};

/** Memoized per request: the live viewer grant for one space. */
const getViewerGrantForSpace = (appSession: CachedAppSessionPrincipal, spaceId: string): Promise<ResolvedViewerGrant | null> => {
  appSession.activeGrants ??= new Map<string, Promise<ResolvedViewerGrant | null>>();
  let grant = appSession.activeGrants.get(spaceId);
  if (!grant) {
    grant = loadViewerGrantForSpace(appSession.appId, appSession.userUuid, spaceId);
    appSession.activeGrants.set(spaceId, grant);
  }
  return grant;
};

/** Memoized per request: live viewer grants across all spaces (account scopes are not space-bound). */
const getViewerGrantsForAnySpace = (appSession: CachedAppSessionPrincipal): Promise<ResolvedViewerGrant[]> => {
  appSession.activeGrants ??= new Map<string, Promise<ResolvedViewerGrant | null>>();
  let grants = appSession.anySpaceGrants;
  if (!grants) {
    grants = (async () => {
      const rows = await db
        .select()
        .from(appViewerGrants)
        .where(and(eq(appViewerGrants.appId, appSession.appId), eq(appViewerGrants.viewerUserUuid, appSession.userUuid)));
      return rows
        .filter(isGrantAlive)
        .map((row) => ({ grantId: row.id, spaceId: row.spaceId, scopes: normalizePermissionScopes(row.scopes as string[]) }));
    })();
    appSession.anySpaceGrants = grants;
  }
  return grants;
};

const getActiveAppState = (appSession: CachedAppSessionPrincipal): Promise<ResolvedAppState | null> => {
  appSession.activeAppState ??= (async () => {
    const [app] = await db
      .select({ status: apps.status, spaceId: apps.spaceId, appScopes: apps.appScopes })
      .from(apps)
      .where(eq(apps.id, appSession.appId))
      .limit(1);
    if (app?.status !== "published" || app.spaceId !== appSession.spaceId) return null;
    return { appScopes: normalizeAppPublisherScopes(app.appScopes as string[]) };
  })();
  return appSession.activeAppState;
};

/** Scopes the viewer consented to on one space; exposed for prompt-auth provenance. */
export const resolveAppSessionViewerGrant = async (
  appSession: AppSessionPrincipal,
  spaceId: string,
): Promise<ResolvedViewerGrant | null> => {
  const cached = appSession as CachedAppSessionPrincipal;
  if (!(await getActiveAppState(cached))) return null;
  return getViewerGrantForSpace(cached, spaceId);
};

/**
 * Whether a live viewer grant currently covers `permission`. The App's
 * published state is the master switch for both publisher and viewer grants.
 */
async function hasActiveViewerGrantPermission(
  appSession: CachedAppSessionPrincipal,
  permission: Permission,
  spaceId?: string,
) {
  if (!(await getActiveAppState(appSession))) return false;
  const grants = spaceId === undefined
    ? await getViewerGrantsForAnySpace(appSession)
    : [await getViewerGrantForSpace(appSession, spaceId)].filter((grant): grant is ResolvedViewerGrant => grant !== null);
  return grants.some((grant) => scopeListHasPermission(grant.scopes, permission));
}

/** Live publisher scopes for the home Space, memoized on the request principal. */
export const resolveAppSessionPublisherScopes = async (
  appSession: AppSessionPrincipal,
  spaceId: string,
): Promise<Permission[]> => {
  if (appSession.spaceId !== spaceId) return [];
  return (await getActiveAppState(appSession as CachedAppSessionPrincipal))?.appScopes ?? [];
};

const resolveAppSessionScopes = async (
  appSession: CachedAppSessionPrincipal,
  spaceId: string,
): Promise<Permission[]> => {
  const activeApp = await getActiveAppState(appSession);
  if (!activeApp) return [];
  const appSide = appSession.spaceId === spaceId ? activeApp.appScopes : [];
  const grant = await getViewerGrantForSpace(appSession, spaceId);
  const viewerSide = grant
    ? intersectPermissionScopes(grant.scopes, await resolveUserSpacePermissions({ uuid: appSession.userUuid }, spaceId))
    : [];
  return normalizePermissionScopes([...appSide, ...viewerSide]);
};

const hasAppSessionScopedPermission = async (
  appSession: CachedAppSessionPrincipal,
  permission: Permission,
  context: { spaceId: string; sessionId?: string },
) => {
  // App-side grant: live publisher scopes, bound to the app home space only.
  if (scopeListHasPermission(await resolveAppSessionPublisherScopes(appSession, context.spaceId), permission)) {
    return true;
  }
  // Viewer-side grant: consented per space, and gated on the viewer's own
  // current access so a lost membership or role downgrade takes effect at once.
  if (!(await hasActiveViewerGrantPermission(appSession, permission, context.spaceId))) return false;
  return hasSharedPermission({
    store: permissionStore,
    user: { uuid: appSession.userUuid },
    permission,
    context,
  });
}

/**
 * The viewer's own permission set on a space, ignoring any app-session
 * principal attached to the same user. One membership + policy resolution
 * answers every scope at once — used to gate what a viewer may grant.
 */
export async function resolveUserSpacePermissions(
  user: { uuid?: string | null } | null | undefined,
  spaceId: string,
): Promise<Permission[]> {
  const access = await resolveSharedPermissionAccess({
    store: permissionStore,
    user: { uuid: user?.uuid ?? null },
    context: { spaceId },
  });
  return access.permissions;
}

export async function hasPermission(
  user: AuthUserProfile | null,
  permission: Permission,
  context: { spaceId: string; sessionId?: string },
): Promise<boolean> {
  if (isUserLevelPermission(permission)) {
    const appSession = getUserAppSession(user);
    if (appSession) return hasActiveViewerGrantPermission(appSession, permission);
    // Preview sessions are space-scoped file-preview tokens; they never hold
    // account-level permissions.
    if (getUserPreviewSession(user)) return false;
    return Boolean(user?.uuid);
  }

  const appSession = getUserAppSession(user);
  if (appSession) return hasAppSessionScopedPermission(appSession, permission, context);
  const previewSession = getUserPreviewSession(user);
  if (previewSession) return hasPreviewSessionPermission(previewSession, permission, context.spaceId);
  const execution = getUserExecution(user);
  if (execution?.spaceId === context.spaceId && scopeListHasPermission(normalizePermissionScopes(execution.scopes ?? []), permission)) return true;
  return hasSharedPermission({
    store: permissionStore,
    user,
    permission,
    context,
  });
}

export async function getRoleForSpaceUser(spaceId: string, userId: string): Promise<SpaceRole | null> {
  return getSpaceMemberRole(spaceId, userId);
}

export async function resolvePermissionAccess(
  user: AuthUserProfile | null,
  context: { spaceId: string; sessionId?: string },
): Promise<PermissionAccess> {
  const appSession = getUserAppSession(user);
  if (appSession) return { role: null, permissions: await resolveAppSessionScopes(appSession, context.spaceId) };
  const previewSession = getUserPreviewSession(user);
  if (previewSession?.spaceId === context.spaceId) return { role: null, permissions: normalizePermissionScopes(previewSession.scopes) };
  const execution = getUserExecution(user);
  const access = await resolveSharedPermissionAccess({
    store: permissionStore,
    user,
    context,
  });
  if (execution?.spaceId !== context.spaceId) return access;
  return {
    role: access.role,
    permissions: normalizePermissionScopes([
      ...access.permissions,
      ...normalizePermissionScopes(execution.scopes ?? []),
    ]),
  };
}

export function canViewSpaceCost(user: AuthUserProfile | null, spaceId: string): Promise<boolean> {
  return hasPermission(user, "member.view", { spaceId });
}

export async function getSessionSpaceId(sessionId: string): Promise<string | null> {
  return permissionStore.getSessionSpaceId(sessionId);
}

type SpaceSessionRow = typeof import("@cohub/db").spaceSessions.$inferSelect;
type AccessPolicyRow = AccessPolicy | null;

export async function filterSessionsByPermission(
  user: AuthUserProfile | null,
  permission: Permission,
  spaceId: string,
  sessions: SpaceSessionRow[],
  spacePolicy?: AccessPolicyRow,
): Promise<SpaceSessionRow[]> {
  const appSession = getUserAppSession(user);
  if (appSession) {
    return await hasAppSessionScopedPermission(appSession, permission, { spaceId }) ? sessions : [];
  }
  const previewSession = getUserPreviewSession(user);
  if (previewSession) return hasPreviewSessionPermission(previewSession, permission, spaceId) ? sessions : [];
  const execution = getUserExecution(user);
  if (execution?.spaceId === spaceId && scopeListHasPermission(normalizePermissionScopes(execution.scopes ?? []), permission)) return sessions;
  return permissionStore.filterSessionsByPermission({
    user,
    permission,
    spaceId,
    sessions,
    spacePolicy,
  });
}

export async function filterSpaceIdsByPermission(
  user: AuthUserProfile | null,
  permission: Permission,
  spaceIds: readonly string[],
): Promise<string[]> {
  if (spaceIds.length === 0) return [];

  const appSession = getUserAppSession(user);
  if (appSession) {
    // Batched: the home space is covered by the app-side grant outright, other
    // spaces by one grant load plus one batched membership check — never one
    // query per space.
    const activeApp = await getActiveAppState(appSession);
    if (!activeApp) return [];
    const allowed = new Set<string>();
    if (
      spaceIds.includes(appSession.spaceId) &&
      scopeListHasPermission(activeApp.appScopes, permission)
    ) {
      allowed.add(appSession.spaceId);
    }
    const grants = await getViewerGrantsForAnySpace(appSession);
    const candidates = spaceIds.filter((spaceId) =>
      !allowed.has(spaceId) &&
      grants.some((grant) => grant.spaceId === spaceId && scopeListHasPermission(grant.scopes, permission)),
    );
    if (candidates.length === 0) return spaceIds.filter((spaceId) => allowed.has(spaceId));
    const userAllowed = await permissionStore.filterSpaceIdsByPermission({
      user: { uuid: appSession.userUuid },
      permission,
      spaceIds: candidates,
    });
    const userSet = new Set(userAllowed);
    return spaceIds.filter((spaceId) => allowed.has(spaceId) || userSet.has(spaceId));
  }

  const previewSession = getUserPreviewSession(user);
  if (previewSession) {
    return hasPreviewSessionPermission(previewSession, permission, previewSession.spaceId)
      ? spaceIds.filter((id) => id === previewSession.spaceId)
      : [];
  }

  const execution = getUserExecution(user);
  const userAllowed = await permissionStore.filterSpaceIdsByPermission({ user, permission, spaceIds });
  if (!execution || !scopeListHasPermission(normalizePermissionScopes(execution.scopes ?? []), permission)) {
    return userAllowed;
  }
  return Array.from(new Set([
    ...userAllowed,
    ...(spaceIds.includes(execution.spaceId) ? [execution.spaceId] : []),
  ])).sort((a, b) => spaceIds.indexOf(a) - spaceIds.indexOf(b));
}
