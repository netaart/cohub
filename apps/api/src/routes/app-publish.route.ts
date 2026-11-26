import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { spaces, apps, appPromotions, appPromotionStatsHourly, appVersions, appViewerGrants, appViewStatsHourly, userProfiles } from "@cohub/db";
import { createAppAssetPublicUrl, deleteAppAssetsByObjectKey } from "../app-asset-storage.js";
import { publishAppAssetInWorker, type AppPublishAssetJobResult } from "../app-publish-asset-queue.js";
import { APP_PUBLISHER_SCOPES, type Permission } from "@cohub/core/permissions";
import { materializeHtmlPageMeta, mergeAppPageMeta } from "@cohub/core/apps";
import { db } from "../db/index.js";
import { isPostgresUniqueViolation } from "../db/postgres-error.js";
import { authzDenied, requireValidId, useAccountPrincipal, useAuth, type AuthUser } from "../lib/middleware.js";
import { hasPermission } from "../permissions.js";
import { APP_DEVICES, MAX_APP_FILE_HANDLERS, parseAppDevices, parseAppFileHandlers, type AppArtifactDescriptor } from "@cohub/protocol";
import {
  appScopesBodyField,
  serializeAppRecord,
  serializeAppVersionRecord,
  wrapAppRecord,
  type AppWire,
} from "./apps-wire.js";
import { createLogger } from "@cohub/infra/logging";
import { billingOperations, COHUB_BILLING_FEATURES } from "@cohub/billing";
import { featureGateResponse } from "../lib/feature-gate.js";
import { applyRequestSourceToMeta, getRequestSource } from "../lib/request-source.js";
import { dispatchAppVersionPublished } from "../app-events.js";
import { notifyAppListChanged } from "../user-lists.js";
import { releaseAppDomainsInTransaction } from "../app-domains.js";
import { resolveAppVersionSources } from "../app-version-source.js";
import { ensureUserProfileByUuid } from "../user-profiles.js";
import { ALLOWED_VIEWER_SCOPES, SLUG_RE, getAppById, isRecord, normalizePortRef } from "./app-content.js";

const logger = createLogger({ serviceName: "cohub-api" });

const APP_STATUSES = new Set(["published", "disabled"]);
const APP_VISIBILITIES = new Set(["public", "space"]);
const TARGET_TYPES = new Set(["file", "directory", "port"]);
/** Direct publisher grants stay deliberately small in v1. */
const ALLOWED_APP_SCOPES = new Set<Permission>(APP_PUBLISHER_SCOPES);

const normalizeScopes = (value: unknown, allowed: Set<Permission>): Permission[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is Permission => typeof item === "string" && allowed.has(item as Permission))));
};

type AppMeta = Record<string, unknown>;

/** Meta as stored: a valid file handler list is normalized (`BOARD` → `.board`). */
const getAppMeta = (value: unknown): AppMeta | null => {
  if (!isRecord(value)) return null;
  const handlers = value.fileHandlers;
  if (!Array.isArray(handlers)) return value;
  const normalized = parseAppFileHandlers(handlers);
  // An invalid list stays as sent, for ensureAppPresentationAllowed to reject.
  return normalized.length === handlers.length ? { ...value, fileHandlers: normalized } : value;
};

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
  const fileHandlers = input.meta?.fileHandlers;
  if (fileHandlers !== undefined && (!Array.isArray(fileHandlers) || parseAppFileHandlers(fileHandlers).length !== fileHandlers.length)) {
    return c.json({ message: `meta.fileHandlers must list up to ${MAX_APP_FILE_HANDLERS} unique extensions like ".board"` }, 400);
  }
  const devices = input.meta?.devices;
  if (devices !== undefined && (!Array.isArray(devices) || parseAppDevices(devices).length !== devices.length)) {
    return c.json({ message: `meta.devices must list unique devices from: ${APP_DEVICES.join(", ")}` }, 400);
  }
  if (!getHideCohubBar(input.meta)) return null;
  if (await canHideCohubBar(input.userId)) return null;
  return appHideCohubBarRequiredResponse(c);
}

const isAppSlugConflict = (error: unknown) => isPostgresUniqueViolation(error, "v2_uq_apps_space_slug");
const invalidAppStatusResponse = (c: Context) => c.json({ message: "status must be one of: published, disabled" }, 400);
const invalidAppVisibilityResponse = (c: Context) => c.json({ message: "visibility must be one of: public, space" }, 400);
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
          fileHandlers: result.extracted.fileHandlers ?? [],
          devices: result.extracted.devices ?? [],
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

export function createAppPublishRouter(wire: AppWire): Hono {
  const router = new Hono();

router.post("/", async (c) => {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const spaceId = typeof body?.spaceId === "string" ? body.spaceId : "";
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "app.manage", { spaceId }))) return authzDenied(c);

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
    notifyAppListChanged(result.app);
    return c.json({
      ...wrapAppRecord(wire, serializeAppRecord(result.app, wire)),
    }, 201);
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
  notifyAppListChanged(app);
  return c.json({
    ...wrapAppRecord(wire, serializeAppRecord(app, wire)),
  });
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
    notifyAppListChanged(result.app);
    return c.json({
      ...wrapAppRecord(wire, serializeAppRecord(result.app, wire)),
      version: serializeAppVersionRecord(result.version, wire, source),
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
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const current = await getAppById(id);
  if (!current) return c.json({ message: "app not found" }, 404);
  if (!(await hasPermission(user, "app.manage", { spaceId: current.spaceId }))) return authzDenied(c);

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
  return c.json({ versions: rows.map((row) => serializeAppVersionRecord(row, wire, sources.get(row.id) ?? null)) });
});

router.post("/:id/versions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (!app) return c.json({ message: "app not found" }, 404);
  if (!(await hasPermission(user, "app.manage", { spaceId: app.spaceId }))) return authzDenied(c);
  const meta = applyRequestSourceToMeta(c, null);
  return publishAppVersion(c, app, { actor: user, meta });
});

router.delete("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const app = await getAppById(id);
  if (!app) return c.json({ message: "app not found" }, 404);
  // Hosts delete any App; builders only the Apps they published themselves.
  const canDelete = (await hasPermission(user, "space.edit", { spaceId: app.spaceId }))
    || (app.userUuid === user.uuid && (await hasPermission(user, "app.manage", { spaceId: app.spaceId })));
  if (!canDelete) return authzDenied(c);
  const afterDomainsReleased = await db.transaction(async (tx) => {
    // Domain creation takes the same row lock, so no binding can slip in.
    await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, app.id)).for("update");
    const releasedDomains = await releaseAppDomainsInTransaction(tx, app.id);
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
    return releasedDomains;
  });
  await afterDomainsReleased();
  notifyAppListChanged(app);
  return c.json({ ok: true });
});

  return router;
}
