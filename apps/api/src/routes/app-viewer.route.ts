import { Hono } from "hono";
import { holdAppBrowserEpoch } from "../lib/app-browser-epoch.js";
import { bodyLimit } from "hono/body-limit";
import { and, desc, eq } from "drizzle-orm";
import { spaces, type apps, appVersions, appViewerGrants } from "@cohub/db";
import { canRenewGrantSilently, hostConsentRefused, parseAppAuthorizeRequest, resolveAppGrantScopes, resolveOfflineGrantScopes } from "../app-grant-scopes.js";
import { isUserLevelPermission, normalizePermissionScopes, scopeListHasPermission, type Permission } from "@cohub/core/permissions";
import {
  APP_ACTION_INPUT_MAX_BYTES,
  buildAppActionCommand,
  isAppActionKey,
  readOfflineScopes,
  withOfflineScopes,
} from "@cohub/core/apps";
import { db } from "../db/index.js";
import {
  authzDenied,
  getExecutionPrincipal,
  getAppSessionPrincipal,
  requireValidId,
  useAccountPrincipal,
  useAuth,
  type AuthUser,
} from "../lib/middleware.js";
import { hasPermission, resolveUserSpacePermissions } from "../permissions.js";
import { createAppSessionToken, APP_SESSION_TTL_SECONDS, APP_VIEWER_GRANT_TTL_SECONDS } from "../app-sessions.js";
import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";
import { serializeAppRecord, wrapAppRecord, type AppWire } from "./apps-wire.js";
import { getRequestSource } from "../lib/request-source.js";
import { requiresSpaceAppAccess } from "../app-access.js";
import { enqueueTask } from "../tasks.js";
import { RUN_COMMAND_TASK_TYPE } from "@cohub/core/commands";
import { ALLOWED_VIEWER_SCOPES, getAppById, isRecord } from "./app-content.js";

const appActionBodyLimit = bodyLimit({
  maxSize: APP_ACTION_INPUT_MAX_BYTES * 2,
  onError: (c) => c.json({ message: "action request is too large" }, 413),
});

/**
 * Scopes the viewer cannot grant for a space: their own current access there
 * must cover every space-level scope (account scopes are always grantable).
 * One permission-set resolution answers all scopes at once.
 */
async function findUngrantableScopes(user: AuthUser, scopes: Permission[], spaceId: string): Promise<Permission[]> {
  const spaceScopes = scopes.filter((scope) => !isUserLevelPermission(scope));
  if (spaceScopes.length === 0) return [];
  const held = await resolveUserSpacePermissions(user, spaceId);
  return spaceScopes.filter((scope) => !scopeListHasPermission(held, scope));
}

/** Extends a live grant that still covers the requested scopes; never revives or widens. */
async function renewViewerGrant(input: {
  existing: typeof appViewerGrants.$inferSelect | undefined;
  requested: Permission[];
  offline: boolean;
}): Promise<typeof appViewerGrants.$inferSelect | null> {
  const { existing } = input;
  if (!existing || !canRenewGrantSilently(input)) return null;
  const [renewed] = await db
    .update(appViewerGrants)
    .set({ expiresAt: new Date(Date.now() + APP_VIEWER_GRANT_TTL_SECONDS * 1000), updatedAt: new Date() })
    .where(eq(appViewerGrants.id, existing.id))
    .returning();
  return renewed ?? null;
}

/**
 * Explicit consent: creates or replaces the grant for (app, viewer, space).
 * Written as a manual upsert so it works under both the legacy two-column and
 * the current three-column unique index — code and migration can roll out in
 * either order. Returns null on a write failure, or "migration_pending" when
 * the legacy index still reserves the (app, viewer) slot for another space.
 * Host consent never revives a revoked grant (checked under the row lock).
 */
async function upsertViewerGrant(input: {
  appId: string;
  spaceId: string;
  viewerUserUuid: string;
  scopes: Permission[];
  expiresAt: Date;
  scopeMode?: "extend";
  consent?: "host";
  offline: boolean;
}): Promise<typeof appViewerGrants.$inferSelect | null | "migration_pending" | "consent_required"> {
  return db.transaction(async (tx) => {
    const key = and(
      eq(appViewerGrants.appId, input.appId),
      eq(appViewerGrants.viewerUserUuid, input.viewerUserUuid),
      eq(appViewerGrants.spaceId, input.spaceId),
    );
    const write = (existing: typeof appViewerGrants.$inferSelect) =>
      tx.update(appViewerGrants).set({
        scopes: resolveAppGrantScopes({ requested: input.scopes, mode: input.scopeMode, existing }),
        expiresAt: input.expiresAt,
        meta: withOfflineScopes(existing.meta, resolveOfflineGrantScopes({ requested: input.scopes, offline: input.offline, mode: input.scopeMode, existing })),
        revokedAt: null,
        updatedAt: new Date(),
      }).where(eq(appViewerGrants.id, existing.id)).returning();

    const refused = (grant: typeof appViewerGrants.$inferSelect) => hostConsentRefused(input.consent === "host", grant);

    const [existing] = await tx.select().from(appViewerGrants).where(key).limit(1).for("update");
    if (existing) return refused(existing) ? "consent_required" : (await write(existing))[0] ?? null;

    const inserted = await tx.insert(appViewerGrants).values({
      appId: input.appId,
      spaceId: input.spaceId,
      viewerUserUuid: input.viewerUserUuid,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      // Provenance only; the row stays the single source of truth for consent.
      meta: withOfflineScopes(input.consent ? { consent: input.consent } : null, input.offline ? input.scopes : []),
    }).onConflictDoNothing().returning();
    if (inserted.length > 0) return inserted[0] ?? null;

    // Lost a concurrent insert, or the legacy (app, viewer) unique index is
    // still in place. Distinguish by re-reading the three-column key.
    const [raced] = await tx.select().from(appViewerGrants).where(key).limit(1).for("update");
    if (!raced) return "migration_pending";
    return refused(raced) ? "consent_required" : (await write(raced))[0] ?? null;
  });
}

const serializeViewerGrant = (grant: typeof appViewerGrants.$inferSelect) => ({
  id: grant.id,
  appId: grant.appId,
  spaceId: grant.spaceId,
  scopes: normalizePermissionScopes(grant.scopes as string[]),
  offlineScopes: readOfflineScopes(grant.meta),
  expiresAt: grant.expiresAt?.toISOString() ?? null,
  revokedAt: grant.revokedAt?.toISOString() ?? null,
  createdAt: grant.createdAt?.toISOString() ?? null,
  updatedAt: grant.updatedAt?.toISOString() ?? null,
});

/**
 * Tokens the sign-in broker hands to a page outside Cohub end with the
 * account's web sign-out on every device. Tokens for Apps embedded in Cohub
 * follow that Cohub session instead.
 */
async function brokerTokenEpoch(user: AuthUser, broker: boolean) {
  return broker ? { browserEpoch: await holdAppBrowserEpoch(user.uuid) } : {};
}

async function buildAppAuthorizationPayload(
  app: typeof apps.$inferSelect,
  user: AuthUser,
  grant: typeof appViewerGrants.$inferSelect,
  broker: boolean,
) {
  const scopes = normalizePermissionScopes(grant.scopes as string[]);
  return {
    token: createAppSessionToken({
      userUuid: user.uuid,
      appId: app.id,
      spaceId: app.spaceId,
      appScopes: app.appScopes as Permission[],
      viewerScopes: scopes,
      ...(await brokerTokenEpoch(user, broker)),
    }),
    expiresIn: APP_SESSION_TTL_SECONDS,
    grant: {
      id: grant.id,
      spaceId: grant.spaceId,
      scopes,
      offlineScopes: readOfflineScopes(grant.meta),
      expiresAt: grant.expiresAt?.toISOString() ?? null,
    },
  };
}

export function createAppViewerRouter(wire: AppWire): Hono {
  const router = new Hono();

router.post("/:id/actions/:action/run", appActionBodyLimit, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  const action = c.req.param("action");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  if (!isAppActionKey(action)) return c.json({ message: "invalid app action" }, 400);

  if (getExecutionPrincipal(c)?.source === APP_ACTION_EXECUTION_SOURCE) return authzDenied(c);
  const appSession = getAppSessionPrincipal(c);
  if (!appSession || appSession.appId !== id) return authzDenied(c);
  const app = await getAppById(id);
  if (app?.status !== "published" || !app.currentVersionId) {
    return c.json({ message: "app not found" }, 404);
  }
  if (app.spaceId !== appSession.spaceId) return authzDenied(c);
  if (app.targetType !== "directory") {
    return c.json({ message: "app actions require a directory app" }, 409);
  }
  const [version] = await db
    .select({ id: appVersions.id, artifact: appVersions.artifact })
    .from(appVersions)
    .where(and(eq(appVersions.id, app.currentVersionId), eq(appVersions.appId, app.id)))
    .limit(1);
  const artifact = isRecord(version?.artifact) ? version.artifact : null;
  if (!version || !isRecord(artifact?.download)) {
    return c.json({ message: "app version is not downloadable" }, 409);
  }

  const body = await c.req.json().catch(() => undefined);
  if (!isRecord(body)) return c.json({ message: "action request must be a JSON object" }, 400);
  const inputBytes = Buffer.byteLength(JSON.stringify(body.input ?? null));
  if (inputBytes > APP_ACTION_INPUT_MAX_BYTES) {
    return c.json({ message: `action input exceeds ${APP_ACTION_INPUT_MAX_BYTES} bytes` }, 413);
  }

  const executionScopes = await resolveUserSpacePermissions({ uuid: app.userUuid }, app.spaceId);
  const sourceClientId = getRequestSource(c)?.clientId;
  const { taskRunId } = await enqueueTask({
    type: RUN_COMMAND_TASK_TYPE,
    spaceId: app.spaceId,
    userId: user.uuid,
    data: {
      actorUserId: app.userUuid,
      command: buildAppActionCommand({
        appId: app.id,
        appVersionId: version.id,
        action,
        actionInput: body.input,
      }),
      actionInput: body.input ?? null,
      cwd: "/workspace",
      source: APP_ACTION_EXECUTION_SOURCE,
      viewerUserId: user.uuid,
      appId: app.id,
      appVersionId: version.id,
      action,
      executionScopes,
      ...(sourceClientId ? { sourceClientId } : {}),
    },
  });

  return c.json({ taskRunId, action, status: "pending" }, 202);
});

router.post("/:id/session", async (c) => {
  if (getExecutionPrincipal(c)?.source === APP_ACTION_EXECUTION_SOURCE) return authzDenied(c);
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (app?.status !== "published") return c.json({ message: "app not found" }, 404);
  if (requiresSpaceAppAccess(app) && !(await hasPermission(user, "space.view", { spaceId: app.spaceId }))) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as { broker?: unknown } | null;
  const token = createAppSessionToken({
    userUuid: user.uuid,
    appId: app.id,
    spaceId: app.spaceId,
    appScopes: app.appScopes as Permission[],
    ...(await brokerTokenEpoch(user, body?.broker === true)),
  });
  return c.json({ token, expiresIn: APP_SESSION_TTL_SECONDS, ...wrapAppRecord(wire, serializeAppRecord(app, wire)) });
});

router.post("/:id/authorize", async (c) => {
  if (getExecutionPrincipal(c)?.source === APP_ACTION_EXECUTION_SOURCE) return authzDenied(c);
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (app?.status !== "published") return c.json({ message: "app not found" }, 404);
  if (requiresSpaceAppAccess(app) && !(await hasPermission(user, "space.view", { spaceId: app.spaceId }))) {
    return c.json({ message: "app is not accessible in this space", code: "app_not_accessible" }, 403);
  }
  const body = await c.req.json().catch(() => null) as { scopes?: unknown; spaceId?: unknown; silent?: unknown; scopeMode?: unknown; consent?: unknown; offline?: unknown; broker?: unknown } | null;
  const broker = body?.broker === true;
  // Hosts send `consent` with `silent`, so an older API falls back to renew-only.
  const parsed = parseAppAuthorizeRequest(body, ALLOWED_VIEWER_SCOPES);
  if ("message" in parsed) return c.json(parsed, 400);
  const { requested, extend, hostConsent, offline } = parsed;
  // Lasting consent comes from the viewer's own sign-in, never from a delegated execution.
  if (offline && getExecutionPrincipal(c)) {
    return c.json({ message: "offline access needs the viewer's own sign-in", code: "account_required" }, 403);
  }
  const targetSpaceId = typeof body?.spaceId === "string" && body.spaceId.trim() ? body.spaceId.trim() : app.spaceId;
  if (!requireValidId(targetSpaceId)) return c.json({ message: "space not found", code: "space_not_found" }, 404);
  // A caller-supplied target must exist — the per-scope permission gate skips
  // account scopes, so without this an arbitrary UUID could become a grant's
  // space id and leave orphan rows behind.
  if (targetSpaceId !== app.spaceId) {
    const [space] = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, targetSpaceId)).limit(1);
    if (!space) return c.json({ message: "space not found", code: "space_not_found" }, 404);
  }

  // A silent refresh (host-side reuse of a previous consent) may only renew a
  // live grant that still covers the requested scopes — it can never create,
  // widen, or revive one. The app owner additionally gets implicit consent for
  // their own app (the publisher auto-authorization path), but a revoked grant
  // never comes back silently for anyone: the owner falls through to the
  // explicit upsert only when no revoked row exists.
  if (body?.silent === true && !hostConsent) {
    const [existing] = await db
      .select()
      .from(appViewerGrants)
      .where(and(
        eq(appViewerGrants.appId, app.id),
        eq(appViewerGrants.viewerUserUuid, user.uuid),
        eq(appViewerGrants.spaceId, targetSpaceId),
      ))
      .limit(1);
    if (existing?.revokedAt) return c.json({ message: "grant was revoked; viewer consent is required again", code: "consent_required" }, 403);
    const renewed = await renewViewerGrant({ existing, requested, offline });
    if (renewed) {
      return c.json(await buildAppAuthorizationPayload(app, user, renewed, broker));
    }
    if (offline || user.uuid !== app.userUuid) {
      return c.json({ message: "grant is no longer active; viewer consent is required again", code: "consent_required" }, 403);
    }
  }

  // Grant-time gate: a viewer may only grant what they can currently do on
  // the target space themselves. Account scopes need no space.
  const ungrantable = await findUngrantableScopes(user, requested, targetSpaceId);
  if (ungrantable.length > 0) {
    // Distinguish "the viewer can't see this Space" from "the viewer can see it
    // but can't grant these scopes" so hosts can fall back instead of showing
    // the viewer a technical error.
    const canView = await hasPermission(user, "space.view", { spaceId: targetSpaceId });
    return c.json({
      message: `you cannot grant these permissions for this space: ${ungrantable.join(", ")}`,
      code: canView ? "scope_not_held" : "space_inaccessible",
    }, 403);
  }

  const expiresAt = new Date(Date.now() + APP_VIEWER_GRANT_TTL_SECONDS * 1000);
  const grant = await upsertViewerGrant({
    appId: app.id,
    spaceId: targetSpaceId,
    viewerUserUuid: user.uuid,
    scopes: requested,
    expiresAt,
    // Host consent only adds to a live grant; it never narrows what the viewer granted.
    ...(extend ? { scopeMode: "extend" as const } : {}),
    ...(hostConsent ? { consent: "host" as const } : {}),
    offline,
  });
  if (grant === "consent_required") {
    return c.json({ message: "grant was revoked; viewer consent is required again", code: "consent_required" }, 403);
  }
  if (grant === "migration_pending") {
    return c.json({ message: "space-scoped grants are not enabled yet; run the pending database migration", code: "migration_pending" }, 409);
  }
  if (!grant) return c.json({ message: "failed to create grant" }, 500);

  return c.json(await buildAppAuthorizationPayload(app, user, grant, broker));
});

router.get("/:id/grants", async (c) => {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (!app) return c.json({ message: "app not found" }, 404);
  const rows = await db
    .select()
    .from(appViewerGrants)
    .where(and(eq(appViewerGrants.appId, app.id), eq(appViewerGrants.viewerUserUuid, user.uuid)))
    .orderBy(desc(appViewerGrants.updatedAt));
  return c.json({ grants: rows.map(serializeViewerGrant) });
});

router.delete("/:id/grants/:grantId", async (c) => {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  const grantId = c.req.param("grantId");
  if (!requireValidId(id) || !requireValidId(grantId)) return c.json({ message: "grant not found" }, 404);
  const [grant] = await db
    .select()
    .from(appViewerGrants)
    .where(and(
      eq(appViewerGrants.id, grantId),
      eq(appViewerGrants.appId, id),
      eq(appViewerGrants.viewerUserUuid, user.uuid),
    ))
    .limit(1);
  if (!grant) return c.json({ message: "grant not found" }, 404);
  const now = new Date();
  await db.update(appViewerGrants).set({ revokedAt: now, updatedAt: now }).where(eq(appViewerGrants.id, grant.id));
  return c.json({ ok: true });
});

  return router;
}
