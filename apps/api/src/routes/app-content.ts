import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { apps, appVersions, userProfiles } from "@cohub/db";
import { createAppAssetPublicUrl, isConfiguredAppAssetPublicUrl } from "../app-asset-storage.js";
import { ALL_PERMISSIONS, type Permission } from "@cohub/core/permissions";
import { db } from "../db/index.js";
import { getSandboxPublicEndpoints } from "../sandbox-public-network.js";
import { SANDBOX_PUBLIC_PORTS } from "@cohub/protocol/ports";
import { config, isHostAllowedBySuffix } from "../config.js";
import { createLogger } from "@cohub/infra/logging";
import { getRequestSource } from "../lib/request-source.js";
import { fallbackPublicUserProfile, type PublicUserProfile } from "../user-profiles.js";
import { recordAppViewStatsHourly, resolveAppViewSource, type AppViewSource } from "../app-view-stats.js";

const logger = createLogger({ serviceName: "cohub-api" });

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
const SANDBOX_PUBLIC_PORT_SET = new Set<number>(SANDBOX_PUBLIC_PORTS as readonly number[]);
/** Viewer grants: any permission the viewer can currently use themselves. */
export const ALLOWED_VIEWER_SCOPES = new Set<Permission>(ALL_PERMISSIONS);

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Public identity of the member who published an App. The public URL and share
 * metadata keep the Space owner's identity, so attribution to the actual
 * publisher is reported separately.
 */
export async function resolveAppPublisher(userUuid: string): Promise<PublicUserProfile> {
  const [profile] = await db
    .select({
      userUuid: userProfiles.userUuid,
      username: userProfiles.username,
      displayName: userProfiles.displayName,
      avatarUrl: userProfiles.avatarUrl,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userUuid, userUuid))
    .limit(1);
  return profile ?? fallbackPublicUserProfile(userUuid);
}

export const normalizePortRef = (value: string) => {
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

export async function getAppById(id: string) {
  const [app] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  return app ?? null;
}

let lastAppViewRecordWarningAt = 0;

export function recordResolvedAppView(
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

const getAppContent = (input: {
  versionId: string;
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
      versionId: input.versionId,
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

export async function getAppVersionContent(
  app: typeof apps.$inferSelect,
  version: typeof appVersions.$inferSelect | null,
) {
  if (app.status !== "published" || !version) return null;
  return getAppContent({
    versionId: version.id,
    spaceId: app.spaceId,
    targetType: version.targetType,
    targetRef: version.targetRef,
    assetKey: version.assetKey,
    contentKind: version.contentKind,
    artifact: version.artifact,
  });
}

export async function getAppCurrentVersion(app: typeof apps.$inferSelect) {
  if (!app.currentVersionId) return null;
  const [version] = await db.select().from(appVersions).where(eq(appVersions.id, app.currentVersionId)).limit(1);
  return version ?? null;
}

export async function getAppVersionByNumber(appId: string, version: number) {
  const [row] = await db
    .select()
    .from(appVersions)
    .where(and(eq(appVersions.appId, appId), eq(appVersions.version, version)))
    .limit(1);
  return row ?? null;
}

export async function getPublishedAppContent(app: typeof apps.$inferSelect) {
  return getAppVersionContent(app, await getAppCurrentVersion(app));
}
