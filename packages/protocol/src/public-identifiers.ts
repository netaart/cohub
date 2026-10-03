export type ReservedPublicIdentifierKind = "username" | "spaceSlug";

export type PublicIdentifierValidationReason = "format" | "reserved";

export type PublicIdentifierValidationResult =
  | { value: string; reason: null }
  | { value: null; reason: PublicIdentifierValidationReason };

export const HOME_SPACE_SLUG = "home";
export const CONFIG_SPACE_SLUG = "config";

const USERNAME_PATTERN = /^(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/;
const SPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;

/**
 * Platform-owned path segments that must not be newly assigned to public
 * identities. Existing stored values remain readable through parse helpers.
 */
export const RESERVED_PLATFORM_PATH_SEGMENTS = Object.freeze([
  "admin",
  "api",
  "assets",
  "auth",
  "callback",
  "changelog",
  "docs",
  "explore",
  "invite",
  "landing",
  "login",
  "logout",
  "new",
  "org",
  "pricing",
  "pwa",
  "referrals",
  "sessions",
  "settings",
  "spaces",
  "static",
  "teams",
  "trending",
  "u",
  "user",
  "users",
  "work-auth",
  "app-auth",
  "zh",
] as const);

const RESERVED_PLATFORM_PATH_SEGMENT_SET = new Set<string>(
  RESERVED_PLATFORM_PATH_SEGMENTS,
);
const RESERVED_SPACE_SLUG_SET = new Set<string>([
  ...RESERVED_PLATFORM_PATH_SEGMENTS,
  // Fixed public route discriminators below /:username/:spaceSlug.
  "join",
  "w",
]);

export function parseUsername(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

export function parseSpaceSlug(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return SPACE_SLUG_PATTERN.test(normalized) ? normalized : null;
}

export function isReservedPublicIdentifier(
  kind: ReservedPublicIdentifierKind,
  value: string,
): boolean {
  const reserved = kind === "username"
    ? RESERVED_PLATFORM_PATH_SEGMENT_SET
    : RESERVED_SPACE_SLUG_SET;
  return reserved.has(value);
}

export function validatePublicIdentifierAssignment(
  kind: ReservedPublicIdentifierKind,
  value: string,
): PublicIdentifierValidationResult {
  const parsed = kind === "username" ? parseUsername(value) : parseSpaceSlug(value);
  if (!parsed) return { value: null, reason: "format" };
  if (isReservedPublicIdentifier(kind, parsed)) {
    return { value: null, reason: "reserved" };
  }
  return { value: parsed, reason: null };
}
