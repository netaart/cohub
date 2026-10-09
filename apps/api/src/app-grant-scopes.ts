import { normalizePermissionScopes, type Permission } from "@cohub/core/permissions";
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
};

export type AppAuthorizeRequestError = { code?: string; message: string };

/** Validates `/authorize` scopes. Host consent implies `extend` and is capped at the Host consent scopes. */
export function parseAppAuthorizeRequest(
  body: { scopes?: unknown; scopeMode?: unknown; consent?: unknown } | null,
  allowed: ReadonlySet<Permission>,
): AppAuthorizeRequest | AppAuthorizeRequestError {
  if (body?.scopeMode !== undefined && body.scopeMode !== "extend") return { code: "invalid_request", message: "invalid scope mode" };
  if (body?.consent !== undefined && body.consent !== "host") return { code: "invalid_request", message: "invalid consent" };
  const hostConsent = body?.consent === "host";
  const extend = hostConsent || body?.scopeMode === "extend";
  const raw = Array.isArray(body?.scopes) ? body.scopes : null;
  const isKnown = (scope: unknown): scope is Permission => typeof scope === "string" && allowed.has(scope as Permission);
  // Merging into a live grant needs every raw scope to be known, not just the valid subset.
  if (extend && !raw?.every(isKnown)) return { code: "invalid_scope", message: "unknown permission scope" };
  const requested = [...new Set((raw ?? []).filter(isKnown))];
  if (requested.length === 0) return { message: "no valid scopes requested" };
  if (hostConsent && !requested.every(isAppHostConsentScope)) return { code: "invalid_scope", message: "these scopes require viewer consent" };
  return { requested, extend, hostConsent };
}

/** Host consent never overrides a viewer who revoked the grant. */
export const hostConsentRefused = (hostConsent: boolean, grant: { revokedAt: Date | null }) =>
  hostConsent && grant.revokedAt !== null;
