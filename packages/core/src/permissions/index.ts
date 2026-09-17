import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { accessPolicies, spaceMembers, spaceSessions } from "@cohub/db";
import type { AccessPolicyResourceType, SpaceRole } from "@cohub/db";

export type Audience = "member_user" | "signed_in_user" | "anonymous_user";
export const ALL_PERMISSIONS = [
  "space.view",
  "space.edit",
  "space.create",
  "space.label.view",
  "space.label.manage",
  "space.label.assign",
  "session.view",
  "session.edit",
  "session.prompt.readonly",
  "session.prompt.fullaccess",
  "session.access.manage",
  "generation.create",
  "file.view",
  "file.view.filtered",
  "file.edit",
  "checkpoint.view",
  "checkpoint.edit",
  "member.view",
  "member.manage",
  "references.view",
  "channel.view",
  "channel.manage",
  "cronjob.view",
  "cronjob.manage",
  "taskrun.view",
  "command.execute",
  "sandbox.view",
  "sandbox.manage",
  "mod.view",
  "mod.manage",
  "space.commerce.view",
  "space.commerce.manage",
  "app.publish",
  "user.space.list",
  "user.session.list",
  "user.taskrun.list",
  "user.usage.read",
] as const;

const ALL_PERMISSION_SET = new Set<Permission>(ALL_PERMISSIONS);

/** Account-level permissions, not bound to a specific space. */
export const USER_LEVEL_PERMISSIONS = new Set<Permission>([
  "user.space.list",
  "user.session.list",
  "user.taskrun.list",
  "user.usage.read",
  "space.create",
]);

export const isUserLevelPermission = (permission: Permission): boolean =>
  USER_LEVEL_PERMISSIONS.has(permission);

export type Permission = typeof ALL_PERMISSIONS[number];

export const APP_PUBLISHER_SCOPES = [
  "space.view",
  "session.view",
  "file.view",
  "file.edit",
  "taskrun.view",
  "session.prompt.readonly",
  "session.prompt.fullaccess",
  "command.execute",
] as const satisfies readonly Permission[];
const APP_PUBLISHER_SCOPE_SET = new Set<Permission>(APP_PUBLISHER_SCOPES);

export const normalizeAppPublisherScopes = (scopes: readonly string[]): Permission[] =>
  normalizePermissionScopes(scopes).filter((scope) => APP_PUBLISHER_SCOPE_SET.has(scope));

export type PermissionSubject = {
  uuid?: string | null;
};

export type AccessPolicy = {
  signedInUserRole: SpaceRole | null;
  anonymousUserRole: SpaceRole | null;
};

export type PermissionAccess = {
  role: SpaceRole | null;
  permissions: Permission[];
};

export type PermissionStore = {
  getSpaceMemberRole(spaceId: string, userId: string): Promise<SpaceRole | null>;
  getAccessPolicy(resourceType: AccessPolicyResourceType, resourceId: string): Promise<AccessPolicy | null>;
  getSessionSpaceId(sessionId: string): Promise<string | null>;
};

export type SpaceSessionLike = {
  id: string;
};

export const ROLE_RANK: Record<SpaceRole, number> = {
  guest: 1,
  builder: 2,
  host: 3,
};

export const compareSpaceRole = (a: SpaceRole, b: SpaceRole) => ROLE_RANK[a] - ROLE_RANK[b];

export const isRoleHigherThan = (a: SpaceRole, b: SpaceRole) => compareSpaceRole(a, b) > 0;

export const isRoleLowerThan = (a: SpaceRole, b: SpaceRole) => compareSpaceRole(a, b) < 0;

export const ROLE_PERMISSIONS: Record<SpaceRole, ReadonlySet<Permission>> = {
  host: new Set([
    "space.view",
    "space.edit",
    "space.label.view",
    "space.label.manage",
    "space.label.assign",
    "session.view",
    "session.edit",
    "session.prompt.readonly",
    "session.prompt.fullaccess",
    "session.access.manage",
    "generation.create",
    "file.view",
    "file.edit",
    "checkpoint.view",
    "checkpoint.edit",
    "member.view",
    "member.manage",
    "references.view",
    "channel.view",
    "channel.manage",
    "cronjob.view",
    "cronjob.manage",
    "taskrun.view",
    "command.execute",
    "sandbox.view",
    "sandbox.manage",
    "mod.view",
    "mod.manage",
    "space.commerce.view",
    "space.commerce.manage",
    "app.publish",
  ]),
  builder: new Set([
    "space.view",
    "space.label.view",
    "space.label.assign",
    "session.view",
    "session.edit",
    "session.prompt.readonly",
    "session.prompt.fullaccess",
    "session.access.manage",
    "generation.create",
    "file.view",
    "file.edit",
    "checkpoint.view",
    "checkpoint.edit",
    "member.view",
    "references.view",
    "channel.view",
    "cronjob.view",
    "cronjob.manage",
    "taskrun.view",
    "command.execute",
    "sandbox.view",
    "mod.view",
    "app.publish",
  ]),
  guest: new Set([
    "space.view",
    "space.label.view",
    "session.view",
    "file.view.filtered",
    "checkpoint.view",
  ]),
};

export const resolveAudience = (user: PermissionSubject | null): Audience => {
  if (user?.uuid) return "signed_in_user";
  return "anonymous_user";
};

export const normalizePermissionScopes = (scopes: readonly string[]): Permission[] => {
  return Array.from(new Set(scopes.filter((scope): scope is Permission => typeof scope === "string" && ALL_PERMISSION_SET.has(scope as Permission))));
};

export const scopeListHasPermission = (scopes: readonly Permission[], permission: Permission) => {
  if (scopes.includes(permission)) return true;
  if (permission === "session.prompt.readonly" && scopes.includes("session.prompt.fullaccess")) return true;
  if (permission === "file.view.filtered" && scopes.includes("file.view")) return true;
  return false;
};

/**
 * Keeps only scopes still covered by `current`, honouring implications
 * (full access covers read-only; file.view covers file.view.filtered).
 */
export function intersectPermissionScopes(
  requested: readonly string[],
  current: readonly Permission[],
): Permission[] {
  return normalizePermissionScopes(requested).filter((scope) => scopeListHasPermission(current, scope));
}

export const permissionsForRole = (role: SpaceRole | null): Permission[] => {
  if (!role) return [];
  return ALL_PERMISSIONS.filter((permission) => roleHasPermission(role, permission));
};

export async function resolvePermissionAccess(input: {
  store: PermissionStore;
  user: PermissionSubject | null;
  context: { spaceId: string; sessionId?: string };
}): Promise<PermissionAccess> {
  if (input.user?.uuid) {
    const memberRole = await input.store.getSpaceMemberRole(input.context.spaceId, input.user.uuid);
    if (memberRole) {
      return {
        role: memberRole,
        permissions: permissionsForRole(memberRole),
      };
    }
  }

  const fallbackRole = await resolveNonMemberRole({
    store: input.store,
    user: input.user,
    spaceId: input.context.spaceId,
    sessionId: input.context.sessionId,
  });
  if (!fallbackRole) return { role: null, permissions: [] };
  return {
    role: fallbackRole,
    permissions: permissionsForRole(fallbackRole),
  };
}

export const roleHasPermission = (role: SpaceRole, permission: Permission) => {
  const permissions = ROLE_PERMISSIONS[role];
  if (!permissions) return false;
  return scopeListHasPermission(Array.from(permissions), permission);
};

async function resolveNonMemberRole(input: {
  store: PermissionStore;
  user: PermissionSubject | null;
  spaceId: string;
  sessionId?: string;
}): Promise<SpaceRole | null> {
  const audience = resolveAudience(input.user);
  const sessionPolicy = input.sessionId ? await input.store.getAccessPolicy("session", input.sessionId) : null;
  const effectivePolicy = sessionPolicy ?? await input.store.getAccessPolicy("space", input.spaceId);
  if (!effectivePolicy) return null;
  return audience === "signed_in_user"
    ? (effectivePolicy.signedInUserRole ?? effectivePolicy.anonymousUserRole ?? null)
    : (effectivePolicy.anonymousUserRole ?? null);
}

export async function hasPermission(input: {
  store: PermissionStore;
  user: PermissionSubject | null;
  permission: Permission;
  context: { spaceId: string; sessionId?: string };
}): Promise<boolean> {
  if (input.user?.uuid) {
    const memberRole = await input.store.getSpaceMemberRole(input.context.spaceId, input.user.uuid);
    if (memberRole) return roleHasPermission(memberRole, input.permission);
  }

  const fallbackRole = await resolveNonMemberRole({
    store: input.store,
    user: input.user,
    spaceId: input.context.spaceId,
    sessionId: input.context.sessionId,
  });
  if (!fallbackRole) return false;
  return roleHasPermission(fallbackRole, input.permission);
}

export async function assertPermission(input: {
  store: PermissionStore;
  user: PermissionSubject | null;
  permission: Permission;
  context: { spaceId: string; sessionId?: string };
  message?: string;
}): Promise<void> {
  if (await hasPermission(input)) return;
  throw new Error(input.message ?? `Access denied: missing ${input.permission} permission for space ${input.context.spaceId}.`);
}

export async function filterSessionsByPermission<TSession extends SpaceSessionLike>(input: {
  store: PermissionStore;
  user: PermissionSubject | null;
  permission: Permission;
  spaceId: string;
  sessions: TSession[];
  spacePolicy?: AccessPolicy | null;
}): Promise<TSession[]> {
  if (input.sessions.length === 0) return [];

  if (input.user?.uuid && (await input.store.getSpaceMemberRole(input.spaceId, input.user.uuid)) !== null) {
    throw new Error(
      "filterSessionsByPermission must not be called for space members. " +
      "Use space-level permission checks instead.",
    );
  }

  const audience = resolveAudience(input.user);
  const resolvedSpacePolicy = input.spacePolicy ?? await input.store.getAccessPolicy("space", input.spaceId);
  const sessionPolicyEntries = await Promise.all(
    input.sessions.map(async (session) => [session.id, await input.store.getAccessPolicy("session", session.id)] as const),
  );
  const sessionPolicyMap = new Map(sessionPolicyEntries);

  return input.sessions.filter((session) => {
    const effective = sessionPolicyMap.get(session.id) ?? resolvedSpacePolicy;
    if (!effective) return false;
    const role = audience === "signed_in_user"
      ? (effective.signedInUserRole ?? effective.anonymousUserRole ?? null)
      : (effective.anonymousUserRole ?? null);
    return role !== null && roleHasPermission(role, input.permission);
  });
}

type DrizzlePermissionDb = PostgresJsDatabase<Record<string, unknown>>;

export function createDrizzlePermissionStore(db: DrizzlePermissionDb): PermissionStore {
  return {
    async getSpaceMemberRole(spaceId, userId) {
      const [member] = await db
        .select({ role: spaceMembers.role })
        .from(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
        .limit(1);
      return member?.role ?? null;
    },
    async getAccessPolicy(resourceType, resourceId) {
      const [policy] = await db
        .select({
          signedInUserRole: accessPolicies.signedInUserRole,
          anonymousUserRole: accessPolicies.anonymousUserRole,
        })
        .from(accessPolicies)
        .where(and(eq(accessPolicies.resourceType, resourceType), eq(accessPolicies.resourceId, resourceId)))
        .limit(1);
      return policy ?? null;
    },
    async getSessionSpaceId(sessionId) {
      const [session] = await db
        .select({ spaceId: spaceSessions.spaceId })
        .from(spaceSessions)
        .where(eq(spaceSessions.id, sessionId))
        .limit(1);
      return session?.spaceId ?? null;
    },
  };
}

export function createBatchDrizzlePermissionStore(db: DrizzlePermissionDb): PermissionStore & {
  filterSessionsByPermission<TSession extends SpaceSessionLike>(input: Omit<Parameters<typeof filterSessionsByPermission<TSession>>[0], "store">): Promise<TSession[]>;
  /**
   * Decide `permission` for many spaces in at most two queries: one membership
   * lookup, one space-level access-policy lookup for the non-member remainder.
   * Use this instead of N× `hasPermission` to avoid connection-pool storms.
   */
  filterSpaceIdsByPermission(input: {
    user: PermissionSubject | null;
    permission: Permission;
    spaceIds: readonly string[];
  }): Promise<string[]>;
} {
  const store = createDrizzlePermissionStore(db);
  const queryDb = db;

  return {
    ...store,
    async filterSessionsByPermission<TSession extends SpaceSessionLike>(input: Omit<Parameters<typeof filterSessionsByPermission<TSession>>[0], "store">) {
      if (input.sessions.length === 0) return [];
      if (input.user?.uuid && (await store.getSpaceMemberRole(input.spaceId, input.user.uuid)) !== null) {
        throw new Error(
          "filterSessionsByPermission must not be called for space members. " +
          "Use space-level permission checks instead.",
        );
      }

      const audience = resolveAudience(input.user);
      const resolvedSpacePolicy = input.spacePolicy ?? await store.getAccessPolicy("space", input.spaceId);
      const sessionIds = input.sessions.map((session) => session.id);
      const sessionPolicyRows = await queryDb
        .select({
          resourceId: accessPolicies.resourceId,
          signedInUserRole: accessPolicies.signedInUserRole,
          anonymousUserRole: accessPolicies.anonymousUserRole,
        })
        .from(accessPolicies)
        .where(and(eq(accessPolicies.resourceType, "session"), inArray(accessPolicies.resourceId, sessionIds)));
      const sessionPolicyMap = new Map(sessionPolicyRows.map((policy) => [policy.resourceId, policy]));

      return input.sessions.filter((session) => {
        const effective = sessionPolicyMap.get(session.id) ?? resolvedSpacePolicy;
        if (!effective) return false;
        const role = audience === "signed_in_user"
          ? (effective.signedInUserRole ?? effective.anonymousUserRole ?? null)
          : (effective.anonymousUserRole ?? null);
        return role !== null && roleHasPermission(role, input.permission);
      });
    },
    async filterSpaceIdsByPermission(input) {
      if (input.spaceIds.length === 0) return [];
      const unique = [...new Set(input.spaceIds)];
      const allowed = new Set<string>();
      const memberSpaceIds = new Set<string>();

      if (input.user?.uuid) {
        const members = await queryDb
          .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
          .from(spaceMembers)
          .where(
            and(eq(spaceMembers.userId, input.user.uuid), inArray(spaceMembers.spaceId, unique)),
          );
        for (const member of members) {
          memberSpaceIds.add(member.spaceId);
          if (roleHasPermission(member.role, input.permission)) allowed.add(member.spaceId);
        }
      }

      // Non-members fall back to space-level access policies only (no session
      // override). Space visibility is the right grain for “can I see this
      // source space?” checks such as incoming reference filtering.
      const remaining = unique.filter((spaceId) => !memberSpaceIds.has(spaceId));
      if (remaining.length > 0) {
        const audience = resolveAudience(input.user);
        const policies = await queryDb
          .select({
            resourceId: accessPolicies.resourceId,
            signedInUserRole: accessPolicies.signedInUserRole,
            anonymousUserRole: accessPolicies.anonymousUserRole,
          })
          .from(accessPolicies)
          .where(
            and(
              eq(accessPolicies.resourceType, "space"),
              inArray(accessPolicies.resourceId, remaining),
            ),
          );
        for (const policy of policies) {
          const role =
            audience === "signed_in_user"
              ? (policy.signedInUserRole ?? policy.anonymousUserRole ?? null)
              : (policy.anonymousUserRole ?? null);
          if (role && roleHasPermission(role, input.permission)) allowed.add(policy.resourceId);
        }
      }

      return unique.filter((spaceId) => allowed.has(spaceId));
    },
  };
}
