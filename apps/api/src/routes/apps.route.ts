import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { spaces, apps, appPromotions, appPromotionStatsHourly, appVersions, appViewerGrants, appViewStatsHourly, userProfiles } from "@cohub/db";
import { createAppAssetPublicUrl, deleteAppAssetsByObjectKey, isConfiguredAppAssetPublicUrl } from "../app-asset-storage.js";
import { publishAppAssetInWorker, type AppPublishAssetJobResult } from "../app-publish-asset-queue.js";
import { resolveAppGrantScopes } from "../app-grant-scopes.js";
import { ALL_PERMISSIONS, APP_PUBLISHER_SCOPES, isUserLevelPermission, normalizePermissionScopes, scopeListHasPermission, type Permission } from "@cohub/core/permissions";
import {
  APP_ACTION_INPUT_MAX_BYTES,
  buildAppActionCommand,
  isAppActionKey,
  materializeHtmlPageMeta,
  mergeAppPageMeta,
} from "@cohub/core/apps";
import { db } from "../db/index.js";
import { isPostgresUniqueViolation } from "../db/postgres-error.js";
import {
  authzDenied,
  getExecutionPrincipal,
  getOptionalAuth,
  getSpacePublicProfile,
  getAppSessionPrincipal,
  requireValidId,
  useAccountPrincipal,
  useAuth,
  type AuthUser,
} from "../lib/middleware.js";
import { hasPermission, resolveUserSpacePermissions } from "../permissions.js";
import { createAppSessionToken, APP_SESSION_TTL_SECONDS, APP_VIEWER_GRANT_TTL_SECONDS } from "../app-sessions.js";
import { getSandboxPublicEndpoints } from "../sandbox-public-network.js";
import type { AppArtifactDescriptor, AppVersionSource } from "@cohub/protocol";
import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";
import { SANDBOX_PUBLIC_PORTS } from "@cohub/protocol/ports";
import { config, isHostAllowedBySuffix } from "../config.js";
import {
  appScopesBodyField,
  serializeAppRecord,
  serializeAppVersionRecord,
  wrapAppRecord,
  wrapAppRecords,
  type AppWire,
  type AppWireRecord,
  type AppWireVersionRecord,
} from "./apps-wire.js";
import { createLogger } from "@cohub/infra/logging";
import { billingOperations, COHUB_BILLING_FEATURES } from "@cohub/billing";
import { featureGateResponse } from "../lib/feature-gate.js";
import { createAppPublicUrl } from "../lib/app-public-url.js";
import { applyRequestSourceToMeta, getRequestSource } from "../lib/request-source.js";
import { dispatchAppVersionPublished } from "../app-events.js";
import { resolveAppVersionSources } from "../app-version-source.js";
import { ensureUserProfileByUuid } from "../user-profiles.js";
import {
  getAppTotalViews,
  getAppViewStats,
  recordAppViewStatsHourly,
  resolveAppViewSource,
  type AppViewSource,
} from "../app-view-stats.js";
import {
  createAppRoom,
  createAppRoomAdmission,
  getAppRoomByCode,
  AppRoomError,
} from "../app-realtime-rooms.js";
import { enqueueTask } from "../tasks.js";
import { RUN_COMMAND_TASK_TYPE } from "@cohub/core/commands";

const logger = createLogger({ serviceName: "cohub-api" });
/**
 * Works REST router factory: the canonical `/api/apps` mount and the legacy
 * `/api/works` mount share every handler; only the wire vocabulary differs.
 */
export function createAppsRouter(wire: AppWire): Hono {
  const router = new Hono();


const APP_STATUSES = new Set(["published", "disabled"]);
const APP_VISIBILITIES = new Set(["public", "space"]);
const TARGET_TYPES = new Set(["file", "directory", "port"]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
/** Public app payloads are safe to edge/browser cache briefly. */
const PUBLIC_APP_HTTP_CACHE = "public, max-age=60, stale-while-revalidate=300";
const PRIVATE_APP_HTTP_CACHE = "private, no-store";
const SANDBOX_PUBLIC_PORT_SET = new Set<number>(SANDBOX_PUBLIC_PORTS as readonly number[]);
const appActionBodyLimit = bodyLimit({
  maxSize: APP_ACTION_INPUT_MAX_BYTES * 2,
  onError: (c) => c.json({ message: "action request is too large" }, 413),
});
/** Direct publisher grants stay deliberately small in v1. */
const ALLOWED_APP_SCOPES = new Set<Permission>(APP_PUBLISHER_SCOPES);
/** Viewer grants: any permission the viewer can currently use themselves. */
const ALLOWED_VIEWER_SCOPES = new Set<Permission>(ALL_PERMISSIONS);


const normalizeScopes = (value: unknown, allowed: Set<Permission>): Permission[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is Permission => typeof item === "string" && allowed.has(item as Permission))));
};

type AppMeta = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

const getAppMeta = (value: unknown): AppMeta | null => isRecord(value) ? value : null;

function getAppSource(meta: AppMeta | null): { type: "upload"; ref: string } | null {
  const runtime = isRecord(meta?.runtime) ? meta.runtime : null;
  const source = isRecord(runtime?.source) ? runtime.source : null;
  return source?.type === "upload" && typeof source.ref === "string" && source.ref.length > 0
    ? { type: "upload", ref: source.ref }
    : null;
}

const getHideCohubBar = (meta: AppMeta | null | undefined): boolean => {
  const presentation = isRecord(meta?.presentation) ? meta.presentation : null;
  return presentation?.hideCohubBar === true;
};

async function canHideCohubBar(userId: string) {
  try {
    const entitlement = await billingOperations.getFeatureEntitlement({
      userId,
      featureKey: COHUB_BILLING_FEATURES.workPublishHideCohubBar,
    });
    return Boolean(entitlement?.enabled);
  } catch (error) {
    logger.warn("[apps] failed to check hide Cohub bar entitlement", { userId, error });
    return false;
  }
}

async function ensureAppPresentationAllowed(c: Context, input: { userId: string; meta: AppMeta | null | undefined }) {
  const presentation = isRecord(input.meta?.presentation) ? input.meta.presentation : null;
  if (presentation?.surface !== undefined && presentation.surface !== "window" && presentation.surface !== "overlay") {
    return c.json({ message: "meta.presentation.surface must be one of: window, overlay" }, 400);
  }
  if (!getHideCohubBar(input.meta)) return null;
  if (await canHideCohubBar(input.userId)) return null;
  return appHideCohubBarRequiredResponse(c);
}

const isAppSlugConflict = (error: unknown) => isPostgresUniqueViolation(error, "v2_uq_apps_space_slug");
const invalidAppStatusResponse = (c: Context) => c.json({ message: "status must be one of: published, disabled" }, 400);
const invalidAppVisibilityResponse = (c: Context) => c.json({ message: "visibility must be one of: public, space" }, 400);
const requiresSpaceAppAccess = (app: Pick<typeof apps.$inferSelect, "visibility">) => (app.visibility ?? "public") === "space";
const appHideCohubBarRequiredResponse = (c: Context) =>
  featureGateResponse(c, {
    source: "work_hide_cohub_bar",
    message: "This option is available on Pro and Max.",
    title: "Upgrade to hide the Cohub bar",
    conversionMessage: "Hiding the Cohub bar is available on Pro and Max.",
  });
async function getAppPublicIdentity(spaceId: string) {
  const [row] = await db
    .select({
      ownerUserUuid: spaces.userUuid,
      spaceSlug: spaces.slug,
      ownerUsername: userProfiles.username,
    })
    .from(spaces)
    .leftJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(eq(spaces.id, spaceId))
    .limit(1);
  return {
    ownerUserUuid: row?.ownerUserUuid ?? null,
    ownerUsername: row?.ownerUsername?.trim() || null,
    spaceSlug: row?.spaceSlug?.trim() || null,
  };
}

async function ensureAppPublicIdentity(c: Context, spaceId: string, actor: AuthUser) {
  let identity = await getAppPublicIdentity(spaceId);
  if (!identity.ownerUsername && identity.ownerUserUuid) {
    await ensureUserProfileByUuid(identity.ownerUserUuid, actor);
    identity = await getAppPublicIdentity(spaceId);
  }
  const missingOwner = !identity.ownerUsername;
  const missingSpaceSlug = !identity.spaceSlug;
  if (!missingOwner && !missingSpaceSlug) return null;
  if (missingOwner && missingSpaceSlug) {
    return c.json({ message: "apps require an owner username and a space slug" }, 400);
  }
  if (missingOwner) return c.json({ message: "apps require an owner username" }, 400);
  return c.json({ message: "apps require a space slug" }, 400);
}

const ensureUniqueAppSlug = async (input: { spaceId: string; slug: string; excludeId?: string }) => {
  const conditions = [eq(apps.spaceId, input.spaceId), eq(apps.slug, input.slug)];
  if (input.excludeId) conditions.push(ne(apps.id, input.excludeId));
  const [existingApp] = await db
    .select({ id: apps.id })
    .from(apps)
    .where(and(...conditions))
    .limit(1);
  return !existingApp;
};

const normalizePortRef = (value: string) => {
  if (!/^\d{2,5}$/.test(value)) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || !SANDBOX_PUBLIC_PORT_SET.has(port)) return null;
  return String(port);
};

const isAllowedAppContentUrl = (url: string, kind: "asset" | "port") => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (kind === "asset") return isConfiguredAppAssetPublicUrl(url);
    return isHostAllowedBySuffix(parsed.hostname, config.allowedAppContentHostSuffixes);
  } catch {
    return false;
  }
};

const serializeApp = (app: typeof apps.$inferSelect): AppWireRecord =>
  serializeAppRecord(app, wire);
const serializeAppVersion = (
  version: typeof appVersions.$inferSelect,
  source: AppVersionSource | null = null,
): AppWireVersionRecord => serializeAppVersionRecord(version, wire, source);

async function getAppById(id: string) {
  const [app] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  return app ?? null;
}

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

/** Extends a live grant that still covers the requested scopes; never revives. */
async function renewViewerGrant(input: {
  existing: typeof appViewerGrants.$inferSelect | undefined;
  requested: Permission[];
}): Promise<typeof appViewerGrants.$inferSelect | null> {
  const { existing } = input;
  if (!existing || existing.revokedAt) return null;
  if (existing.expiresAt && existing.expiresAt.getTime() <= Date.now()) return null;
  // Implication-aware coverage: a full-access grant silently covers a later
  // read-only request instead of forcing a fresh consent dialog.
  const held = normalizePermissionScopes(existing.scopes as string[]);
  if (!input.requested.every((scope) => scopeListHasPermission(held, scope))) return null;
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
 */
async function upsertViewerGrant(input: {
  appId: string;
  spaceId: string;
  viewerUserUuid: string;
  scopes: Permission[];
  expiresAt: Date;
  scopeMode?: "extend";
}): Promise<typeof appViewerGrants.$inferSelect | null | "migration_pending"> {
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
        revokedAt: null,
        updatedAt: new Date(),
      }).where(eq(appViewerGrants.id, existing.id)).returning();

    const [existing] = await tx.select().from(appViewerGrants).where(key).limit(1).for("update");
    if (existing) return (await write(existing))[0] ?? null;

    const inserted = await tx.insert(appViewerGrants).values({
      appId: input.appId,
      spaceId: input.spaceId,
      viewerUserUuid: input.viewerUserUuid,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
    }).onConflictDoNothing().returning();
    if (inserted.length > 0) return inserted[0] ?? null;

    // Lost a concurrent insert, or the legacy (app, viewer) unique index is
    // still in place. Distinguish by re-reading the three-column key.
    const [raced] = await tx.select().from(appViewerGrants).where(key).limit(1).for("update");
    if (!raced) return "migration_pending";
    return (await write(raced))[0] ?? null;
  });
}

const serializeViewerGrant = (grant: typeof appViewerGrants.$inferSelect) => ({
  id: grant.id,
  appId: grant.appId,
  spaceId: grant.spaceId,
  scopes: normalizePermissionScopes(grant.scopes as string[]),
  expiresAt: grant.expiresAt?.toISOString() ?? null,
  revokedAt: grant.revokedAt?.toISOString() ?? null,
  createdAt: grant.createdAt?.toISOString() ?? null,
  updatedAt: grant.updatedAt?.toISOString() ?? null,
});


let lastAppViewRecordWarningAt = 0;

function recordResolvedAppView(
  c: Context,
  app: typeof apps.$inferSelect,
  fallbackSource: AppViewSource,
) {
  if (app.status !== "published" || !app.currentVersionId) return;
  void recordAppViewStatsHourly({
    appId: app.id,
    appVersionId: app.currentVersionId,
    source: resolveAppViewSource(getRequestSource(c), fallbackSource),
  }).catch((error) => {
    const now = Date.now();
    if (now - lastAppViewRecordWarningAt < 60_000) return;
    lastAppViewRecordWarningAt = now;
    logger.warn("[apps] failed to buffer view", { appId: app.id, error });
  });
}

class AppAssetPublishError extends Error {
  constructor(public result: Extract<AppPublishAssetJobResult, { ok: false }>) {
    super(result.message);
  }
}

type WrittenAppAsset = {
  assetKey: string;
  artifact: AppArtifactDescriptor;
  extracted: ReturnType<typeof materializeHtmlPageMeta> | null;
};

async function writeAppAsset(input: {
  spaceId: string;
  slug: string;
  targetType: string;
  targetRef: string;
  sourceType?: "workspace" | "upload";
  sourceRef?: string | null;
  sourceOwner?: string | null;
  status: string;
}): Promise<WrittenAppAsset | null> {
  const { spaceId, slug, targetType, targetRef, sourceType, sourceRef, sourceOwner, status } = input;
  if (status !== "published" || (targetType !== "file" && targetType !== "directory")) return null;
  const result = await publishAppAssetInWorker({ spaceId, slug, targetType, targetRef, sourceType, sourceRef, sourceOwner });
  if (!result.ok) throw new AppAssetPublishError(result);
  const extracted = result.extracted
    ? materializeHtmlPageMeta(
        {
          title: result.extracted.title,
          description: result.extracted.description,
          icon: result.extracted.icon,
          image: result.extracted.image,
              lang: result.extracted.lang ?? null,
          themeColor: result.extracted.themeColor ?? null,
          surface: result.extracted.surface ?? null,
          sourcePath: result.extracted.sourcePath,
        },
        result.assetKey,
        createAppAssetPublicUrl,
      )
    : null;
  return {
    assetKey: result.assetKey,
    // An older worker returns no descriptor; every publish it can perform is an
    // HTML page or site, so `web` reconstructs it faithfully.
    artifact: result.artifact ?? {
      kind: "web",
      mimeType: "text/html",
      sizeBytes: result.sizeBytes,
      fileCount: result.fileCount ?? 1,
    },
    extracted,
  };
}

function withPublishedPageMeta(input: {
  baseMeta: AppMeta | null | undefined;
  extracted: WrittenAppAsset["extracted"];
}) {
  return mergeAppPageMeta(input.baseMeta, input.extracted ?? undefined);
}

function appAssetErrorResponse(c: Context, error: unknown, context: { spaceId: string; targetType: string; targetRef: string }) {
  if (error instanceof AppAssetPublishError) {
    return c.json({ message: error.result.message.toLowerCase().replace(/\.$/, ""), code: error.result.code }, error.result.status as never);
  }
  logger.warn("[apps] failed to write app asset", { ...context, error });
  return c.json({ message: "app asset storage failed" }, 502);
}

async function cleanupAppAssets(assetKey: string | null | undefined, context: { appId: string; spaceId: string; reason: string }) {
  if (!assetKey) return;
  try {
    await deleteAppAssetsByObjectKey(assetKey);
  } catch (error) {
    logger.warn("[apps] failed to delete stale app asset", { ...context, assetKey, error });
  }
}

const getAppContent = (input: {
  spaceId: string;
  targetType: string;
  targetRef: string;
  assetKey: string | null;
  contentKind: string;
  artifact: Record<string, unknown> | null;
}) => {
  if (input.targetType === "port") {
    const portRef = normalizePortRef(input.targetRef);
    if (!portRef) return null;
    const url = getSandboxPublicEndpoints(input.spaceId)[portRef]?.url;
    if (!url || !isAllowedAppContentUrl(url, "port")) return null;
    return { kind: "port" as const, url, targetType: "port" as const, port: portRef };
  }
  if (!input.assetKey) return null;
  const url = createAppAssetPublicUrl(input.assetKey);
  if (!isAllowedAppContentUrl(url, "asset")) return null;
  if (input.contentKind === "board" && input.artifact?.kind === "board") {
    return {
      kind: "board" as const,
      url,
      targetType: "file" as const,
      path: input.targetRef,
      boardId: String(input.artifact.boardId),
      boardVersion: Number(input.artifact.boardVersion),
    };
  }
  const rawDownload = isRecord(input.artifact?.download) ? input.artifact.download : null;
  const manifestKey = typeof rawDownload?.manifestKey === "string" ? rawDownload.manifestKey : null;
  const manifestSha256 = typeof rawDownload?.manifestSha256 === "string" ? rawDownload.manifestSha256 : null;
  const manifestUrl = manifestKey ? createAppAssetPublicUrl(manifestKey) : null;
  const download = manifestUrl && manifestSha256 && isAllowedAppContentUrl(manifestUrl, "asset")
    ? { manifestUrl, manifestSha256 }
    : null;
  if (input.contentKind === "file" && input.artifact?.kind === "file") {
    return {
      kind: "file" as const,
      url,
      targetType: "file" as const,
      path: input.targetRef,
      name: String(input.artifact.name),
      mimeType: typeof input.artifact.mimeType === "string" ? input.artifact.mimeType : null,
      sizeBytes: Number(input.artifact.sizeBytes),
      sha256: String(input.artifact.sha256),
      ...(download ? { download } : {}),
    };
  }
  return {
    kind: "web" as const,
    url,
    targetType: input.targetType as "file" | "directory",
    path: input.targetRef,
    ...(download ? { download } : {}),
  };
};

async function getAppVersionContent(
  app: typeof apps.$inferSelect,
  version: typeof appVersions.$inferSelect | null,
) {
  if (app.status !== "published" || !version) return null;
  return getAppContent({
    spaceId: app.spaceId,
    targetType: version.targetType,
    targetRef: version.targetRef,
    assetKey: version.assetKey,
    contentKind: version.contentKind,
    artifact: version.artifact,
  });
}

async function getAppCurrentVersion(app: typeof apps.$inferSelect) {
  if (!app.currentVersionId) return null;
  const [version] = await db.select().from(appVersions).where(eq(appVersions.id, app.currentVersionId)).limit(1);
  return version ?? null;
}

async function getAppVersionByNumber(appId: string, version: number) {
  const [row] = await db
    .select()
    .from(appVersions)
    .where(and(eq(appVersions.appId, appId), eq(appVersions.version, version)))
    .limit(1);
  return row ?? null;
}

async function getPublishedAppContent(app: typeof apps.$inferSelect) {
  return getAppVersionContent(app, await getAppCurrentVersion(app));
}

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

router.get("/by-slug/:username/:spaceSlug/:appSlug", async (c) => {
  const user = getOptionalAuth(c);
  const username = c.req.param("username");
  const spaceSlug = c.req.param("spaceSlug");
  const appSlug = c.req.param("appSlug");
  if (!username || !SLUG_RE.test(spaceSlug) || !SLUG_RE.test(appSlug)) return c.json({ message: "app not found" }, 404);

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
  const [content, totalViews] = await Promise.all([
    getAppVersionContent(row.app, version),
    getAppTotalViews(row.app.id),
  ]);

  // Public apps are anonymous-readable; space apps depend on the caller. The
  // version provenance is served separately by `/versions`, so this stays
  // cacheable and off the session-resolution hot path.
  c.header(
    "Cache-Control",
    requiresSpaceAppAccess(row.app) ? PRIVATE_APP_HTTP_CACHE : PUBLIC_APP_HTTP_CACHE,
  );
  return c.json({
    ...wrapAppRecord(wire, serializeApp(row.app)),
    space: { id: row.space.id, slug: row.space.slug, name: row.space.name, userUuid: row.space.userUuid, publicProfile: getSpacePublicProfile(row.space) },
    owner: { ...row.owner, username: row.owner.username },
    publicUrl: createAppPublicUrl({ ownerUsername: row.owner.username, spaceSlug: row.space.slug, appSlug: row.app.slug, status: row.app.status }),
    content,
    version: version ? publicVersionSummary(version, null) : null,
    totalViews,
  });
});

/** Public version history for the Cohub bar version switcher. */
router.get("/by-slug/:username/:spaceSlug/:appSlug/versions", async (c) => {
  const user = getOptionalAuth(c);
  const username = c.req.param("username");
  const spaceSlug = c.req.param("spaceSlug");
  const appSlug = c.req.param("appSlug");
  if (!username || !SLUG_RE.test(spaceSlug) || !SLUG_RE.test(appSlug)) return c.json({ message: "app not found" }, 404);

  const [row] = await db
    .select({ spaceId: spaces.id, app: apps })
    .from(userProfiles)
    .innerJoin(spaces, and(eq(spaces.userUuid, userProfiles.userUuid), eq(spaces.slug, spaceSlug)))
    .innerJoin(apps, and(eq(apps.spaceId, spaces.id), eq(apps.slug, appSlug), eq(apps.status, "published")))
    .where(eq(userProfiles.username, username))
    .limit(1);
  if (!row) return c.json({ message: "app not found" }, 404);
  if (requiresSpaceAppAccess(row.app) && !(await hasPermission(user, "space.view", { spaceId: row.spaceId }))) return authzDenied(c);

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
  const sources = await resolveAppVersionSources({ versions, spaceId: row.spaceId, user });
  const hasViewerScopedSource = versions.some((version) => sources.get(version.id)?.session);

  c.header(
    "Cache-Control",
    requiresSpaceAppAccess(row.app) || hasViewerScopedSource
      ? PRIVATE_APP_HTTP_CACHE
      : PUBLIC_APP_HTTP_CACHE,
  );
  return c.json({
    versions: versions.map((version) => publicVersionSummary(version, sources.get(version.id) ?? null)),
  });
});


router.get("/space/:spaceId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);
  const rows = await db.select().from(apps).where(eq(apps.spaceId, spaceId));
  return c.json(wrapAppRecords(wire, rows.map(serializeApp)));
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
  recordResolvedAppView(c, app, "web");
  const space = { id: row.space.id, slug: row.space.slug, name: row.space.name, userUuid: row.space.userUuid, publicProfile: getSpacePublicProfile(row.space) };
  // Content matches what the by-slug page already serves for the same access
  // model, so an in-workspace preview can render a Work reached by public url.
  const [content, totalViews] = await Promise.all([
    getPublishedAppContent(app),
    getAppTotalViews(app.id),
  ]);
  return c.json({
    ...wrapAppRecord(wire, serializeApp(app)),
    space,
    owner: { ...row.owner, username: row.owner.username },
    content,
    totalViews,
  });
});

router.get("/:id/stats", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (!app) return c.json({ message: "app not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId: app.spaceId }))) return authzDenied(c);
  return c.json(await getAppViewStats(app.id));
});

router.get("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (!app) return c.json({ message: "app not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId: app.spaceId }))) return authzDenied(c);
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
  const [content, totalViews] = await Promise.all([
    getPublishedAppContent(app),
    getAppTotalViews(app.id),
  ]);
  return c.json({
    ...wrapAppRecord(wire, serializeApp(app)),
    space,
    owner: { ...row.owner, username: row.owner.username },
    publicUrl: createAppPublicUrl({ ownerUsername: row.owner.username, spaceSlug: row.space.slug, appSlug: app.slug, status: app.status }),
    content,
    totalViews,
  });
});

router.post("/", async (c) => {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const spaceId = typeof body?.spaceId === "string" ? body.spaceId : "";
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const slug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (!SLUG_RE.test(slug)) return c.json({ message: "slug must use lowercase letters, numbers, hyphens, or underscores" }, 400);
  const targetType = typeof body?.targetType === "string" ? body.targetType : "";
  let targetRef = typeof body?.targetRef === "string" ? body.targetRef.trim() : "";
  if (!TARGET_TYPES.has(targetType) || !targetRef) return c.json({ message: "target is invalid" }, 400);
  if (targetType === "port") {
    const portRef = normalizePortRef(targetRef);
    if (!portRef) return c.json({ message: "port is invalid" }, 400);
    targetRef = portRef;
  }
  if (body?.status !== undefined && (typeof body.status !== "string" || !APP_STATUSES.has(body.status))) {
    return invalidAppStatusResponse(c);
  }
  if (body?.visibility !== undefined && (typeof body.visibility !== "string" || !APP_VISIBILITIES.has(body.visibility))) {
    return invalidAppVisibilityResponse(c);
  }
  const status = typeof body?.status === "string" ? body.status : "published";
  const visibility = typeof body?.visibility === "string" ? body.visibility : "public";
  const identityError = await ensureAppPublicIdentity(c, spaceId, user);
  if (identityError) return identityError;
  const meta = getAppMeta(body?.meta);
  const source = getAppSource(meta);
  const presentationError = await ensureAppPresentationAllowed(c, { userId: user.uuid, meta });
  if (presentationError) return presentationError;
  const now = new Date();

  const [existingApp] = await db.select().from(apps).where(and(eq(apps.spaceId, spaceId), eq(apps.slug, slug))).limit(1);
  if (existingApp) return c.json({ message: "slug already exists" }, 409);

  let written: WrittenAppAsset | null = null;
  try {
    written = await writeAppAsset({ spaceId, slug, targetType, targetRef, sourceType: source ? "upload" : "workspace", sourceRef: source?.ref, sourceOwner: user.uuid, status });
  } catch (error) {
    return appAssetErrorResponse(c, error, { spaceId, targetType, targetRef });
  }
  const assetKey = written?.assetKey ?? null;
  const pageMeta = withPublishedPageMeta({ baseMeta: meta, extracted: written?.extracted ?? null });
  const versionMeta = withPublishedPageMeta({
    baseMeta: applyRequestSourceToMeta(c, null),
    extracted: written?.extracted ?? null,
  });

  try {
    const result = await db.transaction(async (tx) => {
      const [createdApp] = await tx.insert(apps).values({
        spaceId,
        userUuid: user.uuid,
        slug,
        status,
        visibility,
        targetType,
        targetRef,
        assetKey,
        latestVersion: status === "published" ? 1 : 0,
        publishedAt: status === "published" ? now : null,
        appScopes: normalizeScopes(body?.[appScopesBodyField(wire)], ALLOWED_APP_SCOPES),
        allowedViewerScopes: normalizeScopes(body?.allowedViewerScopes, ALLOWED_VIEWER_SCOPES),
        meta: pageMeta,
      }).returning();
      if (!createdApp) return null;
      if (status !== "published") return { app: createdApp, version: null };
      const [version] = await tx.insert(appVersions).values({
        appId: createdApp.id,
        version: 1,
        targetType,
        targetRef,
        assetKey,
        contentKind: written?.artifact.kind ?? "web",
        artifact: written?.artifact ?? null,
        meta: versionMeta,
        createdAt: now,
      }).returning();
      if (!version) throw new Error("failed to create app version");
      const [updatedApp] = await tx.update(apps).set({ currentVersionId: version.id }).where(eq(apps.id, createdApp.id)).returning();
      return { app: updatedApp ?? createdApp, version };
    }).catch((error: unknown) => {
      if (isAppSlugConflict(error)) return null;
      throw error;
    });
    if (!result) {
      await cleanupAppAssets(assetKey, { appId: "new", spaceId, reason: "create_slug_conflict" });
      return c.json({ message: "slug already exists" }, 409);
    }
    if (result.version) {
      const source = (
        await resolveAppVersionSources({ versions: [result.version], spaceId, user })
      ).get(result.version.id) ?? null;
      await dispatchAppVersionPublished({
        app: serializeAppRecord(result.app, "canonical"),
        version: serializeAppVersionRecord(result.version, "canonical", source),
        previousVersionId: null,
        actorUserId: user.uuid,
        source: getRequestSource(c),
      }).catch((error) => {
        logger.warn("[apps] failed to dispatch app.version.published", {
          appId: result.app.id,
          version: result.version?.version,
          error,
        });
      });
    }
    return c.json(wrapAppRecord(wire, serializeApp(result.app)), 201);
  } catch (error) {
    await cleanupAppAssets(assetKey, { appId: "new", spaceId, reason: "create_failed" });
    throw error;
  }
});

async function updateApp(
  c: Context,
  current: typeof apps.$inferSelect,
  body: Record<string, unknown> | null,
  actor: AuthUser,
) {
  const nextSlug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : current.slug;
  if (!SLUG_RE.test(nextSlug)) return c.json({ message: "slug must use lowercase letters, numbers, hyphens, or underscores" }, 400);
  if (nextSlug !== current.slug && !(await ensureUniqueAppSlug({ spaceId: current.spaceId, slug: nextSlug, excludeId: current.id }))) {
    return c.json({ message: "slug already exists" }, 409);
  }

  const nextTargetType = typeof body?.targetType === "string" ? body.targetType : current.targetType;
  let nextTargetRef = typeof body?.targetRef === "string" ? body.targetRef.trim() : current.targetRef;
  if (!TARGET_TYPES.has(nextTargetType) || !nextTargetRef) return c.json({ message: "target is invalid" }, 400);
  if (nextTargetType === "port") {
    const portRef = normalizePortRef(nextTargetRef);
    if (!portRef) return c.json({ message: "port is invalid" }, 400);
    nextTargetRef = portRef;
  }
  if (body && "status" in body && (typeof body.status !== "string" || !APP_STATUSES.has(body.status))) {
    return invalidAppStatusResponse(c);
  }
  if (body && "visibility" in body && (typeof body.visibility !== "string" || !APP_VISIBILITIES.has(body.visibility))) {
    return invalidAppVisibilityResponse(c);
  }
  const nextStatus = typeof body?.status === "string" ? body.status : current.status;
  if (nextStatus === "published" && current.status !== "published") {
    return c.json({ message: "publish a version to publish this app" }, 409);
  }
  const nextVisibility = typeof body?.visibility === "string" ? body.visibility : (current.visibility ?? "public");
  const appScopesField = appScopesBodyField(wire);
  const hasAppScopes = appScopesField in (body ?? {});
  const hasAllowedViewerScopes = "allowedViewerScopes" in (body ?? {});
  if (hasAppScopes && !Array.isArray(body?.[appScopesField])) {
    return c.json({ message: `${appScopesField} must be an array when provided` }, 400);
  }
  if (hasAllowedViewerScopes && !Array.isArray(body?.allowedViewerScopes)) {
    return c.json({ message: "allowedViewerScopes must be an array when provided" }, 400);
  }
  const identityError = await ensureAppPublicIdentity(c, current.spaceId, actor);
  if (identityError) return identityError;
  const nextMeta = "meta" in (body ?? {}) ? getAppMeta(body?.meta) : getAppMeta(current.meta);
  const presentationError = await ensureAppPresentationAllowed(c, { userId: actor.uuid, meta: nextMeta });
  if (presentationError) return presentationError;

  const assetKey = nextStatus === "published" ? current.assetKey : null;

  const now = new Date();
  const app = await db.transaction(async (tx) => {
    const [updatedApp] = await tx.update(apps).set({
      slug: nextSlug,
      status: nextStatus,
      visibility: nextVisibility,
      targetType: nextTargetType,
      targetRef: nextTargetRef,
      assetKey,
      currentVersionId: current.currentVersionId,
      latestVersion: current.latestVersion,
      publishedAt: nextStatus === "published" ? (current.publishedAt ?? now) : null,
      appScopes: hasAppScopes
        ? normalizeScopes(body?.[appScopesField], ALLOWED_APP_SCOPES)
        : current.appScopes,
      allowedViewerScopes: hasAllowedViewerScopes
        ? normalizeScopes(body?.allowedViewerScopes, ALLOWED_VIEWER_SCOPES)
        : current.allowedViewerScopes,
      meta: nextMeta,
      updatedAt: now,
    }).where(eq(apps.id, current.id)).returning();
    return updatedApp ?? null;
  }).catch((error: unknown) => {
    if (isAppSlugConflict(error)) return null;
    throw error;
  });
  if (!app) return c.json({ message: "slug already exists" }, 409);
  return c.json(wrapAppRecord(wire, serializeApp(app)));
}

async function publishAppVersion(
  c: Context,
  current: typeof apps.$inferSelect,
  options: { actor: AuthUser; meta?: AppMeta | null },
) {
  const identityError = await ensureAppPublicIdentity(c, current.spaceId, options.actor);
  if (identityError) return identityError;
  let written: WrittenAppAsset | null = null;
  try {
    written = await writeAppAsset({
      spaceId: current.spaceId,
      slug: current.slug,
      targetType: current.targetType,
      targetRef: current.targetRef,
      sourceType: getAppSource(getAppMeta(current.meta)) ? "upload" : "workspace",
      sourceRef: getAppSource(getAppMeta(current.meta))?.ref,
      sourceOwner: current.userUuid,
      status: "published",
    });
  } catch (error) {
    return appAssetErrorResponse(c, error, { spaceId: current.spaceId, targetType: current.targetType, targetRef: current.targetRef });
  }
  const assetKey = written?.assetKey ?? null;
  const versionMeta = withPublishedPageMeta({
    baseMeta: options?.meta ?? null,
    extracted: written?.extracted ?? null,
  });
  const appMeta = withPublishedPageMeta({
    baseMeta: getAppMeta(current.meta),
    extracted: written?.extracted ?? null,
  });

  try {
    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const [versionedApp] = await tx.update(apps).set({
        latestVersion: sql`${apps.latestVersion} + 1`,
        updatedAt: now,
      }).where(eq(apps.id, current.id)).returning({
        latestVersion: apps.latestVersion,
        previousVersionId: apps.currentVersionId,
      });
      if (!versionedApp) throw new Error("failed to reserve app version");
      const [version] = await tx.insert(appVersions).values({
        appId: current.id,
        version: versionedApp.latestVersion,
        targetType: current.targetType,
        targetRef: current.targetRef,
        assetKey,
        contentKind: written?.artifact.kind ?? "web",
        artifact: written?.artifact ?? null,
        meta: versionMeta,
        createdAt: now,
      }).returning();
      if (!version) throw new Error("failed to create app version");
      const [app] = await tx.update(apps).set({
        status: "published",
        assetKey,
        currentVersionId: version.id,
        latestVersion: versionedApp.latestVersion,
        publishedAt: current.publishedAt ?? now,
        meta: appMeta,
        updatedAt: now,
      }).where(eq(apps.id, current.id)).returning();
      if (!app) throw new Error("failed to publish app version");
      return { app, version, previousVersionId: versionedApp.previousVersionId };
    });
    const source = (
      await resolveAppVersionSources({ versions: [result.version], spaceId: current.spaceId, user: options.actor })
    ).get(result.version.id) ?? null;
    await dispatchAppVersionPublished({
      app: serializeAppRecord(result.app, "canonical"),
      version: serializeAppVersionRecord(result.version, "canonical", source),
      previousVersionId: result.previousVersionId,
      actorUserId: options.actor.uuid,
      source: getRequestSource(c),
    }).catch((error) => {
      logger.warn("[apps] failed to dispatch app.version.published", {
        appId: result.app.id,
        version: result.version.version,
        error,
      });
    });
    return c.json({
      ...wrapAppRecord(wire, serializeApp(result.app)),
      version: serializeAppVersion(result.version, source),
    });
  } catch (error) {
    try {
      await cleanupAppAssets(assetKey, { appId: current.id, spaceId: current.spaceId, reason: "publish_failed" });
    } catch (cleanupError) {
      logger.warn("[apps] failed to run publish cleanup", { appId: current.id, spaceId: current.spaceId, cleanupError });
    }
    throw error;
  }
}

router.patch("/:id", async (c) => {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const current = await getAppById(id);
  if (!current) return c.json({ message: "app not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId: current.spaceId }))) return authzDenied(c);

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  return updateApp(c, current, body, user);
});

router.get("/:id/versions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (!app) return c.json({ message: "app not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId: app.spaceId }))) return authzDenied(c);
  const rows = await db.select().from(appVersions).where(eq(appVersions.appId, id)).orderBy(desc(appVersions.version));
  const sources = await resolveAppVersionSources({ versions: rows, spaceId: app.spaceId, user });
  return c.json({ versions: rows.map((row) => serializeAppVersion(row, sources.get(row.id) ?? null)) });
});

router.post("/:id/versions", async (c) => {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (!app) return c.json({ message: "app not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId: app.spaceId }))) return authzDenied(c);
  const meta = applyRequestSourceToMeta(c, null);
  return publishAppVersion(c, app, { actor: user, meta });
});

router.delete("/:id", async (c) => {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (!app) return c.json({ message: "app not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId: app.spaceId }))) return authzDenied(c);
  await db.transaction(async (tx) => {
    const promotions = await tx
      .select({ id: appPromotions.id })
      .from(appPromotions)
      .where(eq(appPromotions.appId, app.id));
    if (promotions.length > 0) {
      await tx.delete(appPromotionStatsHourly).where(
        inArray(appPromotionStatsHourly.promotionId, promotions.map((promotion) => promotion.id)),
      );
    }
    await tx.delete(appPromotions).where(eq(appPromotions.appId, app.id));
    await tx.delete(appViewerGrants).where(eq(appViewerGrants.appId, app.id));
    await tx.delete(appViewStatsHourly).where(eq(appViewStatsHourly.appId, app.id));
    await tx.delete(appVersions).where(eq(appVersions.appId, app.id));
    await tx.delete(apps).where(eq(apps.id, app.id));
  });
  return c.json({ ok: true });
});

const appRoomErrorResponse = (c: Context, error: unknown) => {
  if (!(error instanceof AppRoomError)) return c.json({ message: "failed to create realtime room" }, 503);
  if (error.code === "ROOM_QUOTA_EXCEEDED") return c.json({ code: error.code, message: error.message }, 429);
  const status = error.code === "ROOM_CODE_TAKEN" ? 409 : 400;
  return c.json({ code: error.code, message: error.message }, status);
};

const getPublishedAppForRoom = async (c: Context, appId: string) => {
  const principal = getAppSessionPrincipal(c);
  if (!principal || principal.appId !== appId) return null;
  const app = await getAppById(appId);
  if (app?.status !== "published" || app.spaceId !== principal.spaceId) return null;
  return { principal, app };
};

router.post("/:id/realtime/rooms", async (c) => {
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const context = await getPublishedAppForRoom(c, id);
  if (!context) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as {
    code?: unknown;
    expiresInSeconds?: unknown;
    maxParticipants?: unknown;
    seatPerUser?: unknown;
  } | null;
  try {
    const room = await createAppRoom({
      appId: id,
      code: body?.code,
      expiresInSeconds: body?.expiresInSeconds,
      maxParticipants: body?.maxParticipants,
      seatPerUser: body?.seatPerUser,
    });
    return c.json(createAppRoomAdmission({
      appId: id,
      userUuid: context.principal.userUuid,
      room,
    }));
  } catch (error) {
    return appRoomErrorResponse(c, error);
  }
});

router.post("/:id/realtime/rooms/join", async (c) => {
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const context = await getPublishedAppForRoom(c, id);
  if (!context) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as { code?: unknown } | null;
  const room = await getAppRoomByCode(id, body?.code);
  if (!room || room.appId !== id) return c.json({ code: "ROOM_NOT_FOUND", message: "room not found" }, 404);
  try {
    return c.json(createAppRoomAdmission({
      appId: id,
      userUuid: context.principal.userUuid,
      room,
    }));
  } catch (error) {
    return appRoomErrorResponse(c, error);
  }
});

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
  const token = createAppSessionToken({
    userUuid: user.uuid,
    appId: app.id,
    spaceId: app.spaceId,
    appScopes: app.appScopes as Permission[],
  });
  return c.json({ token, expiresIn: APP_SESSION_TTL_SECONDS, ...wrapAppRecord(wire, serializeApp(app)) });
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
  const body = await c.req.json().catch(() => null) as { scopes?: unknown; spaceId?: unknown; silent?: unknown; scopeMode?: unknown } | null;
  if (body?.scopeMode !== undefined && body.scopeMode !== "extend") return c.json({ code: "invalid_request", message: "invalid scope mode" }, 400);
  if (body?.scopeMode === "extend" && (!Array.isArray(body.scopes) || body.scopes.some((scope) => typeof scope !== "string" || !ALLOWED_VIEWER_SCOPES.has(scope as Permission)))) return c.json({ code: "invalid_scope", message: "unknown permission scope" }, 400);
  const requested = normalizeScopes(body?.scopes, ALLOWED_VIEWER_SCOPES);
  if (requested.length === 0) return c.json({ message: "no valid scopes requested" }, 400);
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
  if (body?.silent === true) {
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
    const renewed = await renewViewerGrant({ existing, requested });
    if (renewed) {
      const renewedScopes = normalizePermissionScopes(renewed.scopes as string[]);
      return c.json({
        token: createAppSessionToken({
          userUuid: user.uuid,
          appId: app.id,
          spaceId: app.spaceId,
          appScopes: app.appScopes as Permission[],
          viewerScopes: renewedScopes,
        }),
        expiresIn: APP_SESSION_TTL_SECONDS,
        grant: { id: renewed.id, spaceId: targetSpaceId, scopes: renewedScopes, expiresAt: renewed.expiresAt?.toISOString() ?? null },
      });
    }
    if (user.uuid !== app.userUuid) {
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
    ...(body?.scopeMode === "extend" ? { scopeMode: "extend" as const } : {}),
  });
  if (grant === "migration_pending") {
    return c.json({ message: "space-scoped grants are not enabled yet; run the pending database migration", code: "migration_pending" }, 409);
  }
  if (!grant) return c.json({ message: "failed to create grant" }, 500);

  const token = createAppSessionToken({
    userUuid: user.uuid,
    appId: app.id,
    spaceId: app.spaceId,
    appScopes: app.appScopes as Permission[],
    viewerScopes: normalizePermissionScopes(grant.scopes),
  });
  return c.json({
    token,
    expiresIn: APP_SESSION_TTL_SECONDS,
    grant: { id: grant.id, spaceId: targetSpaceId, scopes: normalizePermissionScopes(grant.scopes), expiresAt: expiresAt.toISOString() },
  });
});

// ── Viewer grants: list + revoke (the viewer's own consents) ─────────────────

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

