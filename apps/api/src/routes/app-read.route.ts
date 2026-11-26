import { Hono, type Context } from "hono";
import { createAppBrowserSessionRouter } from "./app-browser-session.route.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { spaces, apps, appVersions, userProfiles } from "@cohub/db";
import { db } from "../db/index.js";
import {
  authzDenied,
  getExecutionPrincipal,
  getOptionalAuth,
  getSpacePublicProfile,
  requireValidId,
  useAuth,
} from "../lib/middleware.js";
import { hasPermission } from "../permissions.js";
import { resolveCohubAppOrigin, type AppVersionSource } from "@cohub/protocol";
import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";
import { config } from "../config.js";
import { serializeAppRecord, wrapAppRecord, wrapAppRecords, type AppWire } from "./apps-wire.js";
import { createAppPublicUrl } from "../lib/app-public-url.js";
import { getRequestSource } from "../lib/request-source.js";
import { parseHttpsOriginHostname, resolveCustomDomainBinding } from "../app-domains.js";
import { resolveAppVersionSources } from "../app-version-source.js";
import { requiresSpaceAppAccess } from "../app-access.js";
import { getLikeCount } from "@cohub/core/labels";
import { publicAppPath, redirectTarget, resolvePublicSpace } from "../slug-history.js";
import { getAppWebViews, getAppViewStats } from "../app-view-stats.js";
import { SLUG_RE, getAppById, getAppCurrentVersion, getAppVersionByNumber, getAppVersionContent, getPublishedAppContent, recordResolvedAppView, resolveAppPublisher } from "./app-content.js";

/** Revalidate so a publish shows on the next load; version content is immutable. */
const PUBLIC_APP_HTTP_CACHE = "public, no-cache";
const PRIVATE_APP_HTTP_CACHE = "private, no-store";

/** Read `?cohub_v=` as a positive integer version number. */
function readRequestedVersion(c: Context): { version: number | null; invalid: boolean } {
  const raw = c.req.query("cohub_v");
  if (raw === undefined || raw === "") return { version: null, invalid: false };
  if (!/^\d{1,9}$/.test(raw)) return { version: null, invalid: true };
  const version = Number(raw);
  return version >= 1 ? { version, invalid: false } : { version: null, invalid: true };
}

const publicVersionSummary = (
  version: Pick<typeof appVersions.$inferSelect, "id" | "version" | "contentKind" | "meta" | "createdAt">,
  source: AppVersionSource | null,
) => ({
  id: version.id,
  version: version.version,
  contentKind: version.contentKind,
  source,
  createdAt: version.createdAt?.toISOString() ?? null,
});

async function resolveBoundApp(requestedOrigin: string | undefined, fresh: boolean, expectedId?: string) {
  const hostTemplate = config.appStandaloneHostTemplate;
  const templateAppId = hostTemplate
    ? resolveCohubAppOrigin(requestedOrigin, hostTemplate)
    : null;
  // Custom domains may serve port Apps too; the mapping is authoritative and
  // changes on (un)binding, so their answers are never HTTP-cached.
  const customDomain = templateAppId ? null : parseHttpsOriginHostname(requestedOrigin);
  // `fresh=1` (the auth broker) decides authorization, so it never trusts a cached answer.
  const binding = customDomain
    ? await resolveCustomDomainBinding(customDomain, { fresh })
    : null;
  // A bound origin that cannot be served right now is still that App's origin;
  // the distinct code keeps the auth broker from treating it as unbound.
  if (binding && !binding.active) return { error: "app_origin_unavailable" } as const;
  const appId = templateAppId ?? binding?.appId;
  const error = binding ? "app_origin_unavailable" : "app_origin_not_found";
  if (!appId || (expectedId && expectedId !== appId)) return { error } as const;
  const app = await getAppById(appId);
  if (app?.status !== "published" || requiresSpaceAppAccess(app)) return { error } as const;
  const content = await getPublishedAppContent(app);
  if (content?.kind !== "web" && !(binding && content?.kind === "port")) return { error } as const;
  return { app, content, customDomain, error: null } as const;
}

/**
 * Resolve a published app by its public slug triple. Current slugs take a single join;
 * old usernames / Space slugs fall back to slug history and report `redirectTo`.
 */
async function resolvePublishedAppBySlug(c: Context) {
  const username = c.req.param("username");
  const spaceSlug = c.req.param("spaceSlug");
  const appSlug = c.req.param("appSlug");
  if (!username || !spaceSlug || !appSlug || !SLUG_RE.test(spaceSlug) || !SLUG_RE.test(appSlug)) return null;

  const [row] = await db
    .select({
      owner: { userUuid: userProfiles.userUuid, username: userProfiles.username, displayName: userProfiles.displayName, avatarUrl: userProfiles.avatarUrl },
      space: spaces,
      app: apps,
    })
    .from(userProfiles)
    .innerJoin(spaces, and(eq(spaces.userUuid, userProfiles.userUuid), eq(spaces.slug, spaceSlug)))
    .innerJoin(apps, and(eq(apps.spaceId, spaces.id), eq(apps.slug, appSlug), eq(apps.status, "published")))
    .where(eq(userProfiles.username, username))
    .limit(1);
  if (row) return { ...row, redirectTo: undefined };

  const resolved = await resolvePublicSpace(username, spaceSlug);
  if (!resolved?.redirected) return null;
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.spaceId, resolved.space.id), eq(apps.slug, appSlug), eq(apps.status, "published")))
    .limit(1);
  if (!app) return null;
  const { owner, space } = resolved;
  return {
    owner: { userUuid: owner.userUuid, username: owner.username, displayName: owner.displayName, avatarUrl: owner.avatarUrl },
    space,
    app,
    redirectTo: redirectTarget(c.req.url, publicAppPath(owner.username, space.slug, app.slug)),
  };
}

export function createAppReadRouter(wire: AppWire): Hono {
  const router = new Hono();

async function getPublishedAppPublicIdentity(app: typeof apps.$inferSelect) {
  const [row] = await db
    .select({
      owner: { userUuid: userProfiles.userUuid, username: userProfiles.username, displayName: userProfiles.displayName, avatarUrl: userProfiles.avatarUrl },
      space: spaces,
    })
    .from(spaces)
    .innerJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(eq(spaces.id, app.spaceId))
    .limit(1);
  if (!row?.owner.username || !row.space.slug) return null;
  return {
    // Spread the wire-wrapped record so the identity stays flat (`app` on the
    // canonical mount, `work` on the legacy one) — nesting it under `app` here
    // would double-wrap the record once the caller spreads this object back.
    ...wrapAppRecord(wire, serializeAppRecord(app, wire)),
    space: { id: row.space.id, slug: row.space.slug, name: row.space.name, userUuid: row.space.userUuid, publicProfile: getSpacePublicProfile(row.space) },
    owner: { ...row.owner, username: row.owner.username },
  };
}

async function getPublicAppDetail(app: typeof apps.$inferSelect) {
  const identity = await getPublishedAppPublicIdentity(app);
  if (!identity) return null;
  const [content, totalViews, likeCount, publisher] = await Promise.all([
    getPublishedAppContent(app),
    getAppWebViews(app.id),
    getLikeCount(db, "app", app.id),
    resolveAppPublisher(app.userUuid),
  ]);
  return {
    ...identity,
    publisher,
    publicUrl: createAppPublicUrl({ ownerUsername: identity.owner.username, spaceSlug: identity.space.slug, appSlug: app.slug, status: app.status }),
    content,
    totalViews,
    likeCount,
  };
}

router.route("/", createAppBrowserSessionRouter(async (origin, id) => (await resolveBoundApp(origin, true, id)).app ?? null));

router.get("/by-origin", async (c) => {
  const requestedOrigin = c.req.query("origin")?.trim() || c.req.header("origin")?.trim();
  const recordView = c.req.query("view") === "1";
  const resolved = await resolveBoundApp(requestedOrigin, c.req.query("fresh") === "1");
  const unavailable = (code: "app_origin_not_found" | "app_origin_unavailable") =>
    c.json({ message: code === "app_origin_unavailable" ? "app origin is bound but unavailable" : "app origin not found", code }, 404);
  if (resolved.error) return unavailable(resolved.error);
  const { app, content, customDomain } = resolved;
  const detail = { ...wrapAppRecord(wire, serializeAppRecord(app, wire)), space: { id: app.spaceId }, content };
  if (recordView) recordResolvedAppView(c, app, "web");
  c.header("Cache-Control", recordView || customDomain ? "no-store" : PUBLIC_APP_HTTP_CACHE);
  c.header("Vary", "Origin");
  return c.json(detail);
});

router.get("/by-slug/:username/:spaceSlug/:appSlug", async (c) => {
  const user = getOptionalAuth(c);
  const row = await resolvePublishedAppBySlug(c);
  if (!row) return c.json({ message: "app not found" }, 404);
  if (!row.owner.username || !row.space.slug) return c.json({ message: "app public identity is incomplete" }, 409);
  if (requiresSpaceAppAccess(row.app) && !(await hasPermission(user, "space.view", { spaceId: row.space.id }))) return authzDenied(c);

  const requested = readRequestedVersion(c);
  if (requested.invalid) return c.json({ message: "app version not found" }, 404);
  const version = requested.version === null
    ? await getAppCurrentVersion(row.app)
    : await getAppVersionByNumber(row.app.id, requested.version);
  // An explicit version must exist; the implicit current version may legitimately be absent.
  if (requested.version !== null && !version) return c.json({ message: "app version not found" }, 404);

  recordResolvedAppView(c, row.app, "web");
  const [content, totalViews, likeCount] = await Promise.all([
    getAppVersionContent(row.app, version),
    getAppWebViews(row.app.id),
    getLikeCount(db, "app", row.app.id),
  ]);

  // Public apps are anonymous-readable; space apps depend on the caller. The
  // version provenance is served separately by `/versions`, so this stays
  // cacheable and off the session-resolution hot path.
  c.header(
    "Cache-Control",
    requiresSpaceAppAccess(row.app) ? PRIVATE_APP_HTTP_CACHE : PUBLIC_APP_HTTP_CACHE,
  );
  return c.json({
    ...wrapAppRecord(wire, serializeAppRecord(row.app, wire)),
    space: { id: row.space.id, slug: row.space.slug, name: row.space.name, userUuid: row.space.userUuid, publicProfile: getSpacePublicProfile(row.space) },
    owner: { ...row.owner, username: row.owner.username },
    publisher: await resolveAppPublisher(row.app.userUuid),
    publicUrl: createAppPublicUrl({ ownerUsername: row.owner.username, spaceSlug: row.space.slug, appSlug: row.app.slug, status: row.app.status }),
    content,
    version: version ? publicVersionSummary(version, null) : null,
    totalViews,
    likeCount,
    redirectTo: row.redirectTo,
  });
});

/** Public version history for the Cohub bar version switcher. */
router.get("/by-slug/:username/:spaceSlug/:appSlug/versions", async (c) => {
  const user = getOptionalAuth(c);
  const row = await resolvePublishedAppBySlug(c);
  if (!row) return c.json({ message: "app not found" }, 404);
  if (requiresSpaceAppAccess(row.app) && !(await hasPermission(user, "space.view", { spaceId: row.space.id }))) return authzDenied(c);

  const versions = await db
    .select({
      id: appVersions.id,
      version: appVersions.version,
      contentKind: appVersions.contentKind,
      meta: appVersions.meta,
      createdAt: appVersions.createdAt,
    })
    .from(appVersions)
    .where(eq(appVersions.appId, row.app.id))
    .orderBy(desc(appVersions.version));
  const sources = await resolveAppVersionSources({ versions, spaceId: row.space.id, user });
  const hasViewerScopedSource = versions.some((version) => sources.get(version.id)?.session);

  c.header(
    "Cache-Control",
    requiresSpaceAppAccess(row.app) || hasViewerScopedSource
      ? PRIVATE_APP_HTTP_CACHE
      : PUBLIC_APP_HTTP_CACHE,
  );
  return c.json({
    versions: versions.map((version) => publicVersionSummary(version, sources.get(version.id) ?? null)),
    redirectTo: row.redirectTo,
  });
});

router.get("/space/:spaceId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);
  const rows = await db
    .select()
    .from(apps)
    .where(eq(apps.spaceId, spaceId))
    // Matches `v2_idx_apps_space_updated` exactly; see space-sessions.ts for
    // the same `desc nulls last` spelling that lets btree serve the order.
    .orderBy(sql`${apps.updatedAt} desc nulls last`, desc(apps.createdAt));
  return c.json(wrapAppRecords(wire, rows.map((app) => serializeAppRecord(app, wire))));
});

router.get("/:id/public", async (c) => {
  // Public endpoint used by the standalone app auth broker page to load app
  // metadata + owner info by appId. Mirrors the by-slug access model: only
  // space-visibility apps require space.view; public apps are open.
  const user = getOptionalAuth(c);
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (app?.status !== "published") return c.json({ message: "app not found" }, 404);
  if (requiresSpaceAppAccess(app) && !(await hasPermission(user, "space.view", { spaceId: app.spaceId }))) return authzDenied(c);
  const detail = await getPublicAppDetail(app);
  if (!detail) return c.json({ message: "app public identity is incomplete" }, 409);
  recordResolvedAppView(c, app, "web");
  return c.json(detail);
});

router.get("/:id/stats", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (!app) return c.json({ message: "app not found" }, 404);
  if (!(await hasPermission(user, "app.manage", { spaceId: app.spaceId }))) return authzDenied(c);
  const [stats, totalLikes] = await Promise.all([getAppViewStats(app.id), getLikeCount(db, "app", app.id)]);
  return c.json({ ...stats, summary: { ...stats.summary, totalLikes } });
});

router.get("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (!app) return c.json({ message: "app not found" }, 404);
  const isPublicApp = app.status === "published" && !requiresSpaceAppAccess(app);
  if (!isPublicApp && !(await hasPermission(user, "space.view", { spaceId: app.spaceId }))) return authzDenied(c);
  const [row] = await db
    .select({
      owner: { userUuid: userProfiles.userUuid, username: userProfiles.username, displayName: userProfiles.displayName, avatarUrl: userProfiles.avatarUrl },
      space: spaces,
    })
    .from(spaces)
    .innerJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(eq(spaces.id, app.spaceId))
    .limit(1);
  if (!row) return c.json({ message: "app not found" }, 404);
  if (!row.owner.username || !row.space.slug) return c.json({ message: "app public identity is incomplete" }, 409);
  const space = { id: row.space.id, slug: row.space.slug, name: row.space.name, userUuid: row.space.userUuid, publicProfile: getSpacePublicProfile(row.space) };
  const shouldRecordCliView = getRequestSource(c)?.via === "cli"
    && getExecutionPrincipal(c)?.source !== APP_ACTION_EXECUTION_SOURCE;
  if (shouldRecordCliView) recordResolvedAppView(c, app, "cli");
  const [content, totalViews, likeCount] = await Promise.all([
    getPublishedAppContent(app),
    getAppWebViews(app.id),
    getLikeCount(db, "app", app.id),
  ]);
  return c.json({
    ...wrapAppRecord(wire, serializeAppRecord(app, wire)),
    space,
    owner: { ...row.owner, username: row.owner.username },
    publisher: await resolveAppPublisher(app.userUuid),
    publicUrl: createAppPublicUrl({ ownerUsername: row.owner.username, spaceSlug: row.space.slug, appSlug: app.slug, status: app.status }),
    content,
    totalViews,
    likeCount,
  });
});

  return router;
}
