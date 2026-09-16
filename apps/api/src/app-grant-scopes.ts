import { normalizePermissionScopes, type Permission } from "@cohub/core/permissions";

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
