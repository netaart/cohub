import { readWorkspaceUsages } from "../workspace-usage.js";
import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { AuthUserProfile } from "../auth.js";
import type { ExecutionAuthPrincipal } from "../auth.js";
import type { PreviewSessionPrincipal } from "../preview-sessions.js";
import type { AppSessionPrincipal } from "../app-sessions.js";
import { isUuidOrShortUuid } from "@cohub/protocol/identifiers";

/** AuthUserProfile with guaranteed uuid (returned after auth checks pass). */
export type AuthUser = AuthUserProfile & { uuid: string };

export type RequestPrincipal =
  | { type: "user"; user: AuthUser }
  | { type: "execution"; execution: ExecutionAuthPrincipal }
  | { type: "preview_session"; previewSession: PreviewSessionPrincipal }
  | { type: "app_session"; appSession: AppSessionPrincipal };

import { config } from "../config.js";
import { getProfilesByUuids } from "../user-profiles.js";
import { getSpaceSandboxBySpaceId } from "../space-sandboxes.js";
import { spaceSandboxes } from "@cohub/db";
import { db } from "../db/index.js";
import { inArray } from "drizzle-orm";
import type { spaces } from "@cohub/db";

const principalToAuthUser = (principal: RequestPrincipal | null | undefined): AuthUser | null => {
  if (principal?.type === "user") return principal.user;
  if (principal?.type === "execution" && principal.execution.actorUserId) {
    return {
      uuid: principal.execution.actorUserId,
      id: undefined,
      nick_name: undefined,
      phone_num: undefined,
      avatar_url: undefined,
      execution: principal.execution,
    } as AuthUser & { execution: ExecutionAuthPrincipal };
  }
  if (principal?.type === "app_session") {
    return {
      uuid: principal.appSession.userUuid,
      id: undefined,
      nick_name: undefined,
      phone_num: undefined,
      avatar_url: undefined,
      appSession: principal.appSession,
    } as AuthUser & { appSession: AppSessionPrincipal };
  }
  if (principal?.type === "preview_session") {
    return {
      uuid: principal.previewSession.userUuid,
      id: undefined,
      nick_name: undefined,
      phone_num: undefined,
      avatar_url: undefined,
      previewSession: principal.previewSession,
    } as AuthUser & { previewSession: PreviewSessionPrincipal };
  }
  return null;
};

export const requireValidId = (value: string | null | undefined) =>
  isUuidOrShortUuid(value);

// ── Auth helpers ─────────────────────────────────────────────────────────────

/** Returns the authenticated user or a 401 JSON Response. */
export const requireAuth = (c: Context): AuthUser | Response => {
  const user = getOptionalAuth(c);
  if (user) return user;
  return c.json({ message: "unauthorized" }, 401);
};

/**
 * Returns the authenticated user or a 401 JSON Response.
 * Usage: `const user = useAuth(c); if (user instanceof Response) return user;`
 */
export const useAuth = (c: Context): AuthUser | Response => requireAuth(c);

export const useAccountPrincipal = (c: Context): AuthUser | Response => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  const user = principalToAuthUser(principal);
  if (principal?.type === "user" || (principal?.type === "execution" && user)) return user as AuthUser;
  return principal ? c.json({ message: "forbidden" }, 403) : c.json({ message: "unauthorized" }, 401);
};

/**
 * Returns the authenticated user when present, otherwise null.
 * Use this for routes whose authorization is fully determined by RBAC
 * policies, including signed-in and anonymous access policies.
 */
export const getOptionalAuth = (c: Context): AuthUser | null => {
  return principalToAuthUser(c.get("principal") as RequestPrincipal | null | undefined);
};

export const authzDenied = (c: Context) => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal ? c.json({ message: "forbidden" }, 403) : c.json({ message: "unauthorized" }, 401);
};

export const getExecutionPrincipal = (c: Context): ExecutionAuthPrincipal | null => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal?.type === "execution" ? principal.execution : null;
};

export const getAppSessionPrincipal = (c: Context): AppSessionPrincipal | null => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal?.type === "app_session" ? principal.appSession : null;
};

export const getPreviewSessionPrincipal = (c: Context): PreviewSessionPrincipal | null => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal?.type === "preview_session" ? principal.previewSession : null;
};

// ── Internal request validation ──────────────────────────────────────────────

export const getRequestRemoteAddress = (c: Context) => {
  const info = getConnInfo(c);
  return info.remote.address || null;
};

export const isPrivateNetworkAddress = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) return false;

  const normalized = trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  if (normalized.startsWith("10.")) return true;
  if (normalized.startsWith("192.168.")) return true;

  const ipv4Match = normalized.match(/^172\.(\d{1,3})\./);
  if (ipv4Match) {
    const secondOctet = Number.parseInt(ipv4Match[1] ?? "", 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }

  const lower = normalized.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80:")) return true;

  return false;
};

export const ensureInternalRequest = (c: Context) => {
  const secret = c.req.header("x-worker-secret");
  const expectedSecret = config.workerSecret;
  if (!secret || !expectedSecret) return c.json({ message: "forbidden" }, 403);
  const provided = new TextEncoder().encode(secret);
  const expected = new TextEncoder().encode(expectedSecret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return c.json({ message: "forbidden" }, 403);
  }
  return null;
};

// ── Space helpers ────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_PUBLIC_AVATAR_URL_LENGTH = 2048;

export const normalizePublicAvatarUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PUBLIC_AVATAR_URL_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

export const getSpacePublicProfile = (space: Pick<typeof spaces.$inferSelect, "meta">) => {
  const meta = isRecord(space.meta) ? space.meta : {};
  const profile = isRecord(meta.publicProfile) ? meta.publicProfile : {};
  return { avatarUrl: normalizePublicAvatarUrl(profile.avatarUrl) };
};

export const buildSpaceListItem = async (space: typeof spaces.$inferSelect) => {
  const sandbox = await getSpaceSandboxBySpaceId(space.id);
  const usages = await readWorkspaceUsages(sandbox?.provider === "local" ? [] : [space.id]);
  return {
    ...space,
    publicProfile: getSpacePublicProfile(space),
    workspaceUsage: sandbox?.provider === "local" ? null : usages.get(space.id),
    sandboxStatus: sandbox?.status ?? null,
  };
};

/**
 * Batch version: fetches sandbox statuses for all spaces in a single query
 * and returns the space list with sandboxStatus attached.
 */
export const buildSpaceListItems = async (spaceList: typeof spaces.$inferSelect[]) => {
  if (spaceList.length === 0) return [];

  const sandboxRows = await db
    .select({ spaceId: spaceSandboxes.spaceId, status: spaceSandboxes.status, provider: spaceSandboxes.provider })
    .from(spaceSandboxes)
    .where(inArray(spaceSandboxes.spaceId, spaceList.map((s) => s.id)));

  const statusBySpaceId = new Map(sandboxRows.map((r) => [r.spaceId, r.status]));
  const localIds = new Set(sandboxRows.filter((r) => r.provider === "local").map((r) => r.spaceId));
  const usages = await readWorkspaceUsages(spaceList.filter((s) => !localIds.has(s.id)).map((s) => s.id));
  const profileByUserUuid = await getProfilesByUuids(spaceList.map((space) => space.userUuid));

  return spaceList.map((space) => ({
    ...space,
    publicProfile: getSpacePublicProfile(space),
    sandboxStatus: statusBySpaceId.get(space.id) ?? null,
    workspaceUsage: localIds.has(space.id) ? null : usages.get(space.id),
    ownerProfile: profileByUserUuid.get(space.userUuid) ?? null,
  }));
};

export const buildStorageRepoName = (spaceId: string) => `space-${spaceId}`;
