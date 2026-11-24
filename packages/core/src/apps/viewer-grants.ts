import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { apps, appViewerGrants } from "@cohub/db";
import {
  createDrizzlePermissionStore,
  intersectPermissionScopes,
  normalizeAppPublisherScopes,
  normalizePermissionScopes,
  resolvePermissionAccess,
  type Permission,
} from "../permissions/index.js";

type DrizzlePermissionDb = PostgresJsDatabase<Record<string, unknown>>;

/** The app-side half of a delegated authorization decision. */
export type DelegatedAppAuthorization =
  | { active: false }
  | { active: true; appScopes: Permission[] };

/**
 * Decides the app-side half of a delegated authorization, purely:
 *
 * - A published app is the master switch — once it is missing or disabled the
 *   whole delegation is off, so queued tasks cannot keep running on a
 *   lingering viewer grant.
 * - Publisher scopes bind to the app's home space only. A cross-space target
 *   keeps the delegation active with no app-side scopes; the viewer's own
 *   grant on that space still applies.
 */
export function delegatedAppAuthorization(
  app: { status: string; spaceId: string; appScopes: unknown } | null | undefined,
  targetSpaceId: string,
): DelegatedAppAuthorization {
  if (!app) return { active: false };
  if (app.status !== "published") return { active: false };
  const appScopes = app.spaceId === targetSpaceId
    ? normalizeAppPublisherScopes(app.appScopes as string[])
    : [];
  return { active: true, appScopes };
}

/**
 * Resolves everything a delegated app authorization may do on a space, from
 * server state only: the app's live publisher scopes (home space only) plus
 * the viewer's live grant scopes on the target space. Payload snapshots are
 * references, never authorization.
 */
export async function resolveDelegatedAppScopesAtUseTime(input: {
  db: DrizzlePermissionDb;
  appId: string;
  grantId?: string;
  viewerUserUuid: string;
  spaceId: string;
}): Promise<{ appScopes: Permission[]; viewerScopes: Permission[] }> {
  const [app] = await input.db
    .select({ status: apps.status, spaceId: apps.spaceId, appScopes: apps.appScopes })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  const decision = delegatedAppAuthorization(app, input.spaceId);
  if (!decision.active) return { appScopes: [], viewerScopes: [] };
  const viewerScopes = input.grantId
    ? await resolveViewerGrantScopesAtUseTime({
        db: input.db,
        grantId: input.grantId,
        appId: input.appId,
        viewerUserUuid: input.viewerUserUuid,
        spaceId: input.spaceId,
      })
    : [];
  return { appScopes: decision.appScopes, viewerScopes };
}

/**
 * Re-validates a viewer grant at use time. The row must match its full
 * identity (id + natural key: app, viewer, space) and still be alive, and only
 * scopes the viewer can still exercise on the space survive. Prompt submission
 * and delayed executions (scheduled tasks) both call this, so a revoked grant
 * or a role downgrade never outlives its consent snapshot.
 */
export async function resolveViewerGrantScopesAtUseTime(input: {
  db: DrizzlePermissionDb;
  grantId: string;
  appId: string;
  viewerUserUuid: string;
  spaceId: string;
}): Promise<Permission[]> {
  const [grant] = await input.db
    .select({ scopes: appViewerGrants.scopes, expiresAt: appViewerGrants.expiresAt, revokedAt: appViewerGrants.revokedAt })
    .from(appViewerGrants)
    .where(and(
      eq(appViewerGrants.id, input.grantId),
      eq(appViewerGrants.appId, input.appId),
      eq(appViewerGrants.viewerUserUuid, input.viewerUserUuid),
      eq(appViewerGrants.spaceId, input.spaceId),
    ))
    .limit(1);
  if (!grant || grant.revokedAt) return [];
  if (grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) return [];
  const held = normalizePermissionScopes(grant.scopes as string[]);
  if (held.length === 0) return [];
  const access = await resolvePermissionAccess({
    store: createDrizzlePermissionStore(input.db),
    user: { uuid: input.viewerUserUuid },
    context: { spaceId: input.spaceId },
  });
  return intersectPermissionScopes(held, access.permissions);
}

/**
 * Offline access: Space scopes a viewer consented to for the App's own
 * Actions, usable while nobody is present. They live on the viewer grant row
 * (`meta.offlineScopes`), ignore its interactive expiry, and end only when the
 * grant is revoked.
 */
export function readOfflineScopes(meta: unknown): Permission[] {
  const raw = meta && typeof meta === "object" ? (meta as { offlineScopes?: unknown }).offlineScopes : undefined;
  return Array.isArray(raw) ? normalizePermissionScopes(raw.filter((scope): scope is string => typeof scope === "string")) : [];
}

/** Writes offline scopes into grant meta, keeping other provenance fields. */
export function withOfflineScopes(meta: unknown, scopes: readonly Permission[]): Record<string, unknown> | null {
  const { offlineScopes: _previous, ...rest } = meta && typeof meta === "object" ? meta as Record<string, unknown> : {};
  const next = scopes.length > 0 ? { ...rest, offlineScopes: normalizePermissionScopes([...scopes]) } : rest;
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * Unrevoked offline grants a published App's Actions may draw on for a Space.
 * Only Action runs in the App's home Space qualify: a Space Hook elsewhere runs
 * the same Action in someone else's sandbox and environment. Callers cap each
 * row by what its viewer can do on the resource at use time.
 */
export async function listOfflineAppGrants(input: {
  db: DrizzlePermissionDb;
  appId: string;
  spaceId: string;
  executionSpaceId: string;
}): Promise<{ viewerUserUuid: string; scopes: Permission[] }[]> {
  const [app] = await input.db
    .select({ status: apps.status, spaceId: apps.spaceId, appScopes: apps.appScopes })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  if (!app || app.spaceId !== input.executionSpaceId || !delegatedAppAuthorization(app, input.spaceId).active) return [];
  const rows = await input.db
    .select({ viewerUserUuid: appViewerGrants.viewerUserUuid, meta: appViewerGrants.meta })
    .from(appViewerGrants)
    .where(and(
      eq(appViewerGrants.appId, input.appId),
      eq(appViewerGrants.spaceId, input.spaceId),
      isNull(appViewerGrants.revokedAt),
      hasOfflineScopes,
    ));
  return rows
    .map((row) => ({ viewerUserUuid: row.viewerUserUuid, scopes: readOfflineScopes(row.meta) }))
    .filter((row) => row.scopes.length > 0);
}

/** SQL filter for grant rows that carry offline scopes. */
export const hasOfflineScopes = sql`jsonb_array_length(coalesce(${appViewerGrants.meta} -> 'offlineScopes', '[]'::jsonb)) > 0`;
