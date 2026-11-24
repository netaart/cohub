import { readOfflineScopes } from "@cohub/core/apps";
import { isUserLevelPermission, normalizePermissionScopes, scopeListHasPermission, type Permission } from "@cohub/core/permissions";
import { isAppHostConsentScope } from "@cohub/protocol";

/** Only a live grant participates in incremental consent; never revive old scopes. */
export function resolveAppGrantScopes(input: {
  requested: Permission[];
  mode?: "extend";
  existing: { scopes: string[]; revokedAt: Date | null; expiresAt: Date | null };
  now?: number;
}): Permission[] {
  const { existing } = input;
  const live = !existing.revokedAt && (!existing.expiresAt || existing.expiresAt.getTime() > (input.now ?? Date.now()));
  return normalizePermissionScopes(input.mode === "extend" && live
    ? [...existing.scopes, ...input.requested]
    : input.requested);
}

export type AppAuthorizeRequest = {
  requested: Permission[];
  /** Merge into a live grant instead of replacing it. */
  extend: boolean;
  /** The trusted Shell consented; it may create or widen, never revive. */
  hostConsent: boolean;
  /** The viewer also lets the App's Actions use these scopes while nobody is present. */
  offline: boolean;
};

export type AppAuthorizeRequestError = { code?: string; message: string };

/** Validates `/authorize` scopes. Host consent implies `extend` and is capped at the Host consent scopes. */
export function parseAppAuthorizeRequest(
  body: { scopes?: unknown; scopeMode?: unknown; consent?: unknown; offline?: unknown } | null,
  allowed: ReadonlySet<Permission>,
): AppAuthorizeRequest | AppAuthorizeRequestError {
  if (body?.scopeMode !== undefined && body.scopeMode !== "extend") return { code: "invalid_request", message: "invalid scope mode" };
  if (body?.consent !== undefined && body.consent !== "host") return { code: "invalid_request", message: "invalid consent" };
  if (body?.offline !== undefined && typeof body.offline !== "boolean") return { code: "invalid_request", message: "invalid offline flag" };
  const offline = body?.offline === true;
  if (offline && body?.consent === "host") return { code: "invalid_request", message: "offline access needs the viewer's own consent" };
  const hostConsent = body?.consent === "host";
  const extend = hostConsent || body?.scopeMode === "extend";
  const raw = Array.isArray(body?.scopes) ? body.scopes : null;
  const isKnown = (scope: unknown): scope is Permission => typeof scope === "string" && allowed.has(scope as Permission);
  // Merging into a live grant needs every raw scope to be known, not just the valid subset.
  if (extend && !raw?.every(isKnown)) return { code: "invalid_scope", message: "unknown permission scope" };
  const requested = [...new Set((raw ?? []).filter(isKnown))];
  if (requested.length === 0) return { message: "no valid scopes requested" };
  if (hostConsent && !requested.every(isAppHostConsentScope)) return { code: "invalid_scope", message: "these scopes require viewer consent" };
  if (offline && requested.some(isUserLevelPermission)) return { code: "invalid_scope", message: "offline access covers Space permissions only" };
  return { requested, extend, hostConsent, offline };
}

/** Host consent never overrides a viewer who revoked the grant. */
export const hostConsentRefused = (hostConsent: boolean, grant: { revokedAt: Date | null }) =>
  hostConsent && grant.revokedAt !== null;

type StoredGrant = { scopes: string[]; revokedAt: Date | null; expiresAt: Date | null; meta: unknown };

/** Offline scopes after an explicit consent. Only an offline request changes them; a revoked grant keeps none. */
export function resolveOfflineGrantScopes(input: {
  requested: Permission[];
  offline: boolean;
  mode?: "extend";
  existing?: StoredGrant;
}): Permission[] {
  const held = input.existing && !input.existing.revokedAt ? readOfflineScopes(input.existing.meta) : [];
  if (!input.offline) return held;
  return normalizePermissionScopes(input.mode === "extend" ? [...held, ...input.requested] : input.requested);
}

/**
 * A silent refresh may renew a grant without a dialog when the viewer already
 * consented: a live grant covering the scopes, or offline access covering them
 * (consented until revoked). An offline request needs the latter.
 */
export function canRenewGrantSilently(input: {
  existing: StoredGrant | undefined;
  requested: Permission[];
  offline: boolean;
  now?: number;
}): boolean {
  const { existing } = input;
  if (!existing || existing.revokedAt) return false;
  const covers = (held: Permission[]) => input.requested.every((scope) => scopeListHasPermission(held, scope));
  if (covers(readOfflineScopes(existing.meta))) return true;
  if (input.offline) return false;
  const live = !existing.expiresAt || existing.expiresAt.getTime() > (input.now ?? Date.now());
  // Implication-aware coverage: a full-access grant silently covers a later read-only request.
  return live && covers(normalizePermissionScopes(existing.scopes));
}
