import type { Context } from "hono";
import type { spaces } from "@cohub/db";
import { toPublicSpaceMeta } from "../../session-space.js";
import { readWorkspaceUsage } from "../../workspace-usage.js";
import { getAppSessionPrincipal, buildSpaceListItems, getSpacePublicProfile } from "../../lib/middleware.js";
import { attachSandboxPublicEndpoints } from "../../sandbox-public-network.js";
import { sanitizeSpaceBootstrapSource } from "../../space-bootstrap-source.js";
import { getSpaceSandboxBySpaceId } from "../../space-sandboxes.js";
import { hasPermission, getSpaceMemberRole, resolvePermissionAccess } from "../../permissions.js";
import type { AuthUser } from "../../lib/middleware.js";
import { resolveSpaceGuestAppId } from "../../space-guest.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../../user-profiles.js";

export type SpaceRow = typeof spaces.$inferSelect;

/**
 * Remove fields that are sensitive or irrelevant when a Work runtime session
 * lists the viewer's spaces. All omitted fields are already optional in the
 * SDK type, so the response stays type-compatible.
 */
function stripSpaceEnv(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const { extraEnv, ...safeMeta } = meta as Record<string, unknown>;
  void extraEnv;
  return safeMeta;
}

function stripSensitiveSpaceFields(item: Record<string, unknown>): Record<string, unknown> {
  const { storageRepoName, sandboxStatus, access, meta, ...rest } = item;
  void storageRepoName;
  void sandboxStatus;
  void access;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const { extraEnv, config, ...safeMeta } = meta as Record<string, unknown>;
    void extraEnv;
    void config;
    return { ...rest, meta: safeMeta };
  }
  return rest;
}

function toPublicSpaceResponse(response: Awaited<ReturnType<typeof serializeSpaceForResponse>>) {
  const { sandbox } = response;
  return {
    ...response,
    storageRepoName: null,
    baseCheckpointId: null,
    headCheckpointId: null,
    workspaceUsage: null,
    meta: toPublicSpaceMeta(response.meta),
    sandbox: sandbox && {
      status: sandbox.status,
      runtimeStatus: sandbox.runtimeStatus,
      publicEndpoints: sandbox.publicEndpoints,
    },
  };
}

export async function buildSpaceResponse(c: Context, space: SpaceRow, user: AuthUser | null) {
  const full = await serializeSpaceForResponse(space, user);
  const canEdit = await hasPermission(user, "space.edit", { spaceId: space.id });
  if (!canEdit) full.meta = stripSpaceEnv(full.meta);
  const response = canEdit || (await hasPermission(user, "member.view", { spaceId: space.id }))
    ? full
    : toPublicSpaceResponse(full);
  if (!getAppSessionPrincipal(c)) return response;
  const [item] = await buildSpaceListItems([space]);
  return item ? stripSensitiveSpaceFields({ ...item, meta: response.meta }) : response;
}

async function resolveSpaceRelation(space: SpaceRow, user: AuthUser | null): Promise<"owner" | "member" | "public"> {
  if (!user?.uuid) return "public";
  if (space.userUuid === user.uuid) return "owner";
  return (await getSpaceMemberRole(space.id, user.uuid)) ? "member" : "public";
}

export async function serializeSpaceForResponse(space: typeof spaces.$inferSelect, user: AuthUser | null) {
  const [sandbox, access, relation] = await Promise.all([
    getSpaceSandboxBySpaceId(space.id),
    resolvePermissionAccess(user, { spaceId: space.id }),
    resolveSpaceRelation(space, user),
  ]);
  const [profileMap, workspaceUsage] = await Promise.all([
    getProfilesByUuids([space.userUuid]),
    readWorkspaceUsage(space.id, sandbox),
  ]);
  const ownerProfile = profileMap.get(space.userUuid) ?? fallbackPublicUserProfile(space.userUuid);

  return {
    ...space,
    meta: sanitizeSpaceMeta(space.meta),
    publicProfile: getSpacePublicProfile(space),
    sandboxStatus: sandbox?.status ?? null,
    sandbox: attachSandboxPublicEndpoints(sandbox),
    workspaceUsage,
    access,
    relation,
    ownerProfile,
  };
}

function sanitizeSpaceMeta(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return meta as null;
  }
  const metaObj = meta as Record<string, unknown>;
  const bootstrap = metaObj.bootstrap;
  if (
    !bootstrap ||
    typeof bootstrap !== "object" ||
    Array.isArray(bootstrap)
  ) {
    return metaObj;
  }
  const bootstrapObj = bootstrap as Record<string, unknown>;
  const source = bootstrapObj.source;
  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source)
  ) {
    return metaObj;
  }
  return {
    ...metaObj,
    bootstrap: {
      ...bootstrapObj,
      source: sanitizeSpaceBootstrapSource(source),
    },
  };
}

export async function buildMinimalSpaceResponse(space: SpaceRow) {
  return {
    id: space.id,
    name: space.name,
    slug: space.slug,
    accessLevel: "minimal" as const,
    guestAppId: await resolveSpaceGuestAppId(space),
  };
}
