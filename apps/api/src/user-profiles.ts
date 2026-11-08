import { randomInt } from "node:crypto";
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { AuthUser } from "./lib/middleware.js";
import { db } from "./db/index.js";
import { userProfiles } from "@cohub/db";
import { getLogtoUser, updateLogtoUserProfile } from "./logto-management.js";
import { createLogger } from "@cohub/infra/logging";
import { getPostgresErrorConstraint, isPostgresUniqueViolation } from "./db/postgres-error.js";
import {
  parseUsername,
  validatePublicIdentifierAssignment,
} from "@cohub/protocol/public-identifiers";
import { nextUsernameChangeAt, recordUsernameChange } from "./slug-history.js";


const logger = createLogger({ serviceName: "cohub-api" });
export type PublicUserProfile = {
  userUuid: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type UserProfile = PublicUserProfile & {
  logtoUserId?: string;
  syncedAt: string;
};

export class UsernameConflictError extends Error {
  override name = "UsernameConflictError";
}

export class UsernameChangeTooSoonError extends Error {
  override name = "UsernameChangeTooSoonError";
  constructor(readonly nextAllowedAt: Date) {
    super(`username can be changed again after ${nextAllowedAt.toISOString()}`);
  }
}

export class UsernameClearError extends Error {
  override name = "UsernameClearError";
}

export class UsernameReservedError extends Error {
  override name = "UsernameReservedError";
}

export class LogtoUserRequiredError extends Error {
  override name = "LogtoUserRequiredError";
}

type UserProfileFields = {
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  source: Record<string, unknown>;
};

type UserProfileRow = typeof userProfiles.$inferSelect;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const stringValue = (source: Record<string, unknown>, key: string) => {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const nestedStringValue = (source: Record<string, unknown>, path: string[]) => {
  let current: unknown = source;
  for (const key of path) current = asRecord(current)[key];
  return typeof current === "string" && current.trim() ? current.trim() : null;
};

const emailLocalPart = (value: string | null) => {
  if (!value) return null;
  const [local] = value.split("@");
  return local?.trim() || null;
};

const fallbackDisplayName = (userUuid: string) => userUuid.replaceAll("-", "").slice(0, 8);

const USERNAME_MAX_LENGTH = 39;
const DEFAULT_USERNAME_REGEX = /^[a-z][a-z0-9]*$/;
const DEFAULT_USERNAME_SUFFIX_ATTEMPTS = 8;
/** Inclusive range for conflict suffixes — wide space so common email locals rarely retry. */
const DEFAULT_USERNAME_SUFFIX_MIN = 1_000;
const DEFAULT_USERNAME_SUFFIX_MAX = 1_000_000; // 1000..999999
const DEFAULT_USERNAME_ALLOCATE_ROUNDS = 3;

/** Slugify a raw string into a base accepted by both Cohub and Logto. */
export function slugifyUsernameBase(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, USERNAME_MAX_LENGTH);
  if (!slug || !DEFAULT_USERNAME_REGEX.test(slug)) return null;
  return slug;
}

/** Email local-part → username base. Display name is intentionally not used. */
export function usernameBaseFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const local = emailLocalPart(email);
  if (!local) return null;
  return slugifyUsernameBase(local);
}

function normalizeAssignableUsername(value: string): string | null {
  return validatePublicIdentifierAssignment("username", value).value;
}

function uuidUsernameFallback(userUuid: string): string {
  const compact = userUuid.replaceAll("-", "").toLowerCase();
  // The letter prefix satisfies Logto's first-character requirement.
  return normalizeAssignableUsername(`u${compact.slice(0, 12)}`) ?? `u${compact.slice(0, 12)}`.slice(0, USERNAME_MAX_LENGTH);
}

function withRandomSuffix(base: string): string | null {
  const suffix = String(randomInt(DEFAULT_USERNAME_SUFFIX_MIN, DEFAULT_USERNAME_SUFFIX_MAX));
  const maxBaseLen = USERNAME_MAX_LENGTH - suffix.length;
  if (maxBaseLen < 1) return null;
  const trimmed = base.slice(0, maxBaseLen);
  if (!trimmed) return null;
  const candidate = `${trimmed}${suffix}`;
  if (!DEFAULT_USERNAME_REGEX.test(candidate)) return null;
  return normalizeAssignableUsername(candidate);
}

/** Build preferred and email-based candidates, followed by stable uuid fallbacks. */
export function buildDefaultUsernameCandidates(input: {
  email?: string | null;
  preferredUsername?: string | null;
  userUuid: string;
  randomSuffixCount?: number;
}): string[] {
  const candidates: string[] = [];
  const bases = [
    input.preferredUsername ? slugifyUsernameBase(input.preferredUsername) : null,
    usernameBaseFromEmail(input.email ?? null),
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  for (const base of bases) {
    const bare = normalizeAssignableUsername(base);
    if (bare) candidates.push(bare);
    const suffixCount = input.randomSuffixCount ?? DEFAULT_USERNAME_SUFFIX_ATTEMPTS;
    for (let i = 0; i < suffixCount; i += 1) {
      const candidate = withRandomSuffix(base);
      if (candidate) candidates.push(candidate);
    }
  }

  candidates.push(uuidUsernameFallback(input.userUuid));
  for (let i = 0; i < 4; i += 1) {
    const candidate = withRandomSuffix(`u${input.userUuid.replaceAll("-", "").toLowerCase().slice(0, 8)}`);
    if (candidate) candidates.push(candidate);
  }

  return [...new Set(candidates)];
}

async function filterLocallyAvailableUsernames(input: {
  candidates: string[];
  userUuid: string;
}): Promise<string[]> {
  if (input.candidates.length === 0) return [];

  const takenRows = await db
    .select({ username: userProfiles.username })
    .from(userProfiles)
    .where(and(
      inArray(userProfiles.username, input.candidates),
      ne(userProfiles.userUuid, input.userUuid),
    ));
  const taken = new Set(takenRows.map((row) => row.username).filter((value): value is string => Boolean(value)));
  return input.candidates.filter((candidate) => !taken.has(candidate));
}

function getLogtoManagementErrorStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Logto management(?: token)? request failed:\s*(\d{3})\b/i);
  return match?.[1] ? Number(match[1]) : null;
}

function isLogtoUsernameConflict(error: unknown): boolean {
  const status = getLogtoManagementErrorStatus(error);
  return status === 409 || status === 422;
}

export function isRecoverableUsernameReconciliationError(error: unknown): boolean {
  if (isLogtoUsernameConflict(error)) return true;
  const status = getLogtoManagementErrorStatus(error);
  if (status === 408 || status === 425 || status === 429 || (status !== null && status >= 500)) {
    return true;
  }
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

export function normalizeUsername(value: string | null | undefined): string | null {
  return parseUsername(value);
}

export function resolveSyncedUsername(
  candidate: string | null | undefined,
  historicalUsername: string | null | undefined,
): string | null {
  const username = normalizeUsername(candidate);
  if (!username) return null;
  if (username === normalizeUsername(historicalUsername)) return username;
  return validatePublicIdentifierAssignment("username", username).reason === "reserved"
    ? null
    : username;
}

export function validateUsername(value: unknown) {
  if (value === null || value === undefined) {
    return { username: null, error: null };
  }
  if (typeof value !== "string") {
    return { username: null, error: "username must be a string or null" };
  }
  const normalized = normalizeUsername(value);
  if (!normalized) {
    return {
      username: null,
      error: "username must be 1-39 characters, lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen",
    };
  }
  return { username: normalized, error: null };
}

export function normalizeUserProfile(input: {
  userUuid: string;
  source: Record<string, unknown>;
}): UserProfileFields {
  const source = input.source;
  const primaryEmail =
    stringValue(source, "primaryEmail") ??
    stringValue(source, "email") ??
    nestedStringValue(source, ["profile", "email"]);
  const username = normalizeUsername(
    stringValue(source, "username") ??
    nestedStringValue(source, ["profile", "username"]),
  );
  const displayName =
    stringValue(source, "name") ??
    nestedStringValue(source, ["profile", "name"]) ??
    stringValue(source, "nickname") ??
    stringValue(source, "nick_name") ??
    username ??
    emailLocalPart(primaryEmail) ??
    fallbackDisplayName(input.userUuid);
  const avatarUrl =
    stringValue(source, "avatar_url") ??
    stringValue(source, "picture") ??
    stringValue(source, "avatar") ??
    nestedStringValue(source, ["profile", "avatar"]) ??
    null;

  return {
    username,
    displayName: displayName.slice(0, 120),
    avatarUrl,
    source,
  };
}

function normalizeSyncedUserProfile(input: {
  userUuid: string;
  source: Record<string, unknown>;
  historicalUsername?: string | null;
}): UserProfileFields {
  const fields = normalizeUserProfile(input);
  return {
    ...fields,
    username: resolveSyncedUsername(fields.username, input.historicalUsername),
  };
}

const toUserProfile = (row: UserProfileRow): UserProfile => ({
  userUuid: row.userUuid,
  logtoUserId: row.logtoUserId,
  username: row.username ?? null,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl ?? null,
  syncedAt: row.syncedAt instanceof Date ? row.syncedAt.toISOString() : new Date().toISOString(),
});

const toPublicUserProfile = (row: UserProfileRow): PublicUserProfile => ({
  userUuid: row.userUuid,
  username: row.username ?? null,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl ?? null,
});

async function upsertUserProfile(input: {
  userUuid: string;
  logtoUserId: string;
  fields: UserProfileFields;
  /** Explicit renames honor the rename interval; Logto-driven syncs only record history. */
  limitUsernameChange?: boolean;
}) {
  const now = new Date();
  // Logto is the source of truth: persist fields.username as-is (including null).
  // Never rehydrate a local-only username that Logto does not have.
  const fields = input.fields;
  const set = {
    logtoUserId: input.logtoUserId,
    username: fields.username,
    displayName: fields.displayName,
    avatarUrl: fields.avatarUrl,
    source: fields.source,
    syncedAt: now,
    updatedAt: now,
  };
  const upsert = (executor: Pick<typeof db, "insert">, setWhere?: SQL) => executor
    .insert(userProfiles)
    .values({ userUuid: input.userUuid, ...set })
    .onConflictDoUpdate({ target: userProfiles.userUuid, set, setWhere })
    .returning();
  try {
    // Hot path: a new profile or an unchanged username needs no history, so skip the locked transaction.
    let [row] = await upsert(db, sql`${userProfiles.username} is null or ${userProfiles.username} = ${fields.username}`);
    row ??= await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ username: userProfiles.username })
        .from(userProfiles)
        .where(eq(userProfiles.userUuid, input.userUuid))
        .for("update")
        .limit(1);
      const previousUsername = current?.username ?? null;
      if (previousUsername && previousUsername !== fields.username) {
        const nextAllowedAt = input.limitUsernameChange ? await nextUsernameChangeAt(input.userUuid, tx) : null;
        if (nextAllowedAt) throw new UsernameChangeTooSoonError(nextAllowedAt);
        await recordUsernameChange(tx, input.userUuid, previousUsername);
      }
      return (await upsert(tx))[0];
    });

    if (!row) throw new Error("failed to upsert user profile");
    return toUserProfile(row);
  } catch (error) {
    const constraint = getPostgresErrorConstraint(error);
    if (isPostgresUniqueViolation(error) && constraint === "v2_uq_user_profiles_username") {
      throw new UsernameConflictError("username is already taken");
    }
    throw error;
  }
}

async function getStoredUserProfile(userUuid: string): Promise<UserProfile | null> {
  const [row] = await db.select().from(userProfiles).where(eq(userProfiles.userUuid, userUuid)).limit(1);
  return row ? toUserProfile(row) : null;
}

function sourceFromAuthUser(user: AuthUser): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(user).filter(([, value]) => value !== undefined),
  );
}

function emailFromSource(source: Record<string, unknown>): string | null {
  return (
    stringValue(source, "primaryEmail") ??
    stringValue(source, "email") ??
    nestedStringValue(source, ["profile", "email"])
  );
}

function emailFromAuthUser(user: AuthUser): string | null {
  return typeof user.email === "string" && user.email.trim() ? user.email.trim() : null;
}

/** Prefer JWT email; fall back to the synced profile source (Logto primaryEmail). */
export async function resolveCurrentUserEmail(user: AuthUser): Promise<string | null> {
  const fromAuth = emailFromAuthUser(user);
  if (fromAuth) return fromAuth;

  const [row] = await db
    .select({ source: userProfiles.source })
    .from(userProfiles)
    .where(eq(userProfiles.userUuid, user.uuid))
    .limit(1);
  if (!row) return null;
  return emailFromSource(asRecord(row.source));
}

function mergeAuthEmailIntoFields(user: AuthUser, fields: UserProfileFields): UserProfileFields {
  const authEmail = emailFromAuthUser(user);
  if (!authEmail || emailFromSource(fields.source)) return fields;
  return { ...fields, source: { ...fields.source, email: authEmail } };
}

/** Commit username to Logto first, then re-read so local can mirror SoT. */
async function commitUsernameToLogto(input: {
  userUuid: string;
  logtoUserId: string;
  username: string;
  historicalUsername?: string | null;
}): Promise<UserProfileFields> {
  await updateLogtoUserProfile(input.logtoUserId, { username: input.username });
  const updated = await getLogtoUser(input.logtoUserId);
  const fields = normalizeSyncedUserProfile({
    userUuid: input.userUuid,
    source: updated,
    historicalUsername: input.historicalUsername,
  });
  if (!fields.username) {
    throw new Error("Logto accepted username update but returned an invalid username");
  }
  return fields;
}

/**
 * Ensure Logto has a username, then return fields from Logto.
 * Never invents a local-only username. Order:
 * 1) Logto already has one (caller hot path)
 * 2) Promote an existing local username into Logto
 * 3) Allocate from email (+ wide random suffix) via Logto write
 */
async function assignDefaultUsernameViaLogto(input: {
  userUuid: string;
  logtoUserId: string;
  fields: UserProfileFields;
  stored: UserProfile | null;
  preferredUsername?: string | null;
}): Promise<UserProfileFields> {
  if (input.fields.username) return input.fields;

  // Promote only a username cached under the same verified Logto identity.
  const stored = input.stored?.logtoUserId === input.logtoUserId ? input.stored : null;
  if (stored?.username) {
    try {
      return await commitUsernameToLogto({
        userUuid: input.userUuid,
        logtoUserId: input.logtoUserId,
        username: stored.username,
        historicalUsername: stored.username,
      });
    } catch (error) {
      if (!isLogtoUsernameConflict(error)) {
        logger.warn("[user-profile] Failed to promote local username to Logto:", {
          userUuid: input.userUuid,
          username: stored.username,
          error,
        });
        throw error;
      }
      // Local handle is taken in Logto globally — fall through to a fresh allocation.
      logger.warn("[user-profile] Local username conflicts in Logto; allocating a new default:", {
        userUuid: input.userUuid,
        username: stored.username,
      });
    }
  }

  const email = emailFromSource(input.fields.source);
  let lastError: unknown = null;

  for (let round = 0; round < DEFAULT_USERNAME_ALLOCATE_ROUNDS; round += 1) {
    let candidates = await filterLocallyAvailableUsernames({
      candidates: buildDefaultUsernameCandidates({
        email,
        preferredUsername: input.preferredUsername,
        userUuid: input.userUuid,
      }),
      userUuid: input.userUuid,
    });

    // Always keep a uuid fallback even if the local filter emptied the list.
    if (candidates.length === 0) {
      candidates = [uuidUsernameFallback(input.userUuid)];
    }

    for (const username of candidates) {
      try {
        return await commitUsernameToLogto({
          userUuid: input.userUuid,
          logtoUserId: input.logtoUserId,
          username,
        });
      } catch (error) {
        lastError = error;
        if (isLogtoUsernameConflict(error)) {
          // Try next candidate in the wide random suffix space.
          continue;
        }
        // Non-conflict Logto failures must not invent a local-only username.
        logger.warn("[user-profile] Failed to assign default username in Logto:", {
          userUuid: input.userUuid,
          username,
          error,
        });
        throw error;
      }
    }
  }

  logger.warn("[user-profile] Exhausted default username candidates for Logto assignment:", {
    userUuid: input.userUuid,
    error: lastError,
  });
  throw lastError instanceof Error
    ? lastError
    : new UsernameConflictError("unable to allocate a default username");
}

async function persistSyncedUserProfile(input: {
  userUuid: string;
  logtoUserId: string;
  fields: UserProfileFields;
  stored: UserProfile | null;
}): Promise<UserProfile> {
  let fields = input.fields;

  for (let attempt = 0; attempt <= DEFAULT_USERNAME_ALLOCATE_ROUNDS; attempt += 1) {
    try {
      return await upsertUserProfile({
        userUuid: input.userUuid,
        logtoUserId: input.logtoUserId,
        fields,
      });
    } catch (error) {
      if (!(error instanceof UsernameConflictError) || !fields.username) throw error;

      if (attempt === DEFAULT_USERNAME_ALLOCATE_ROUNDS) {
        if (input.stored) return input.stored;
        return await upsertUserProfile({
          userUuid: input.userUuid,
          logtoUserId: input.logtoUserId,
          fields: { ...fields, username: null },
        });
      }

      const conflictingUsername = fields.username;
      try {
        fields = await assignDefaultUsernameViaLogto({
          userUuid: input.userUuid,
          logtoUserId: input.logtoUserId,
          fields: { ...fields, username: null },
          stored: null,
          preferredUsername: conflictingUsername,
        });
      } catch (error) {
        if (!isRecoverableUsernameReconciliationError(error)) throw error;
        if (input.stored) return input.stored;
        return await upsertUserProfile({
          userUuid: input.userUuid,
          logtoUserId: input.logtoUserId,
          fields: { ...fields, username: null },
        });
      }
    }
  }

  throw new Error("unreachable username reconciliation state");
}

export function resolveTrustedLogtoUserId(input: {
  userUuid: string;
  tokenLogtoUserId?: string | null;
  storedLogtoUserId?: string | null;
}): string | null {
  const tokenLogtoUserId = input.tokenLogtoUserId?.trim();
  if (tokenLogtoUserId) return tokenLogtoUserId;

  const storedLogtoUserId = input.storedLogtoUserId?.trim();
  if (!storedLogtoUserId || storedLogtoUserId === input.userUuid) return null;
  return storedLogtoUserId;
}

function transientUserProfile(user: AuthUser, stored: UserProfile | null): UserProfile {
  const fields = normalizeUserProfile({ userUuid: user.uuid, source: sourceFromAuthUser(user) });
  return {
    userUuid: user.uuid,
    // Without a verified Logto identity, local username data is not authoritative.
    username: null,
    displayName: stored?.displayName ?? fields.displayName,
    avatarUrl: stored?.avatarUrl ?? fields.avatarUrl,
    syncedAt: stored?.syncedAt ?? new Date().toISOString(),
  };
}

async function syncUserProfileFromLogto(input: {
  user: AuthUser;
  logtoUserId: string;
  stored: UserProfile | null;
}): Promise<UserProfile> {
  const stored = input.stored?.logtoUserId === input.logtoUserId ? input.stored : null;
  let logtoUser: Record<string, unknown>;
  try {
    logtoUser = await getLogtoUser(input.logtoUserId);
  } catch (error) {
    logger.warn("[user-profile] Failed to refresh current user from Logto, using stored profile when available:", {
      userUuid: input.user.uuid,
      logtoUserId: input.logtoUserId,
      error,
    });
    if (stored) return stored;

    // A verified user token established this binding even when Logto is temporarily unavailable.
    return await persistSyncedUserProfile({
      userUuid: input.user.uuid,
      logtoUserId: input.logtoUserId,
      fields: mergeAuthEmailIntoFields(
        input.user,
        normalizeSyncedUserProfile({
          userUuid: input.user.uuid,
          source: sourceFromAuthUser(input.user),
        }),
      ),
      stored: null,
    });
  }

  let fields = mergeAuthEmailIntoFields(
    input.user,
    normalizeSyncedUserProfile({
      userUuid: input.user.uuid,
      source: logtoUser,
      historicalUsername: stored?.username,
    }),
  );

  if (!fields.username) {
    try {
      // Write Logto first; only then mirror into local. Never invent local-only.
      fields = await assignDefaultUsernameViaLogto({
        userUuid: input.user.uuid,
        logtoUserId: input.logtoUserId,
        fields,
        stored,
      });
    } catch (error) {
      logger.warn("[user-profile] Default username assignment failed; not writing local-only username:", {
        userUuid: input.user.uuid,
        error,
      });
      if (stored) return stored;
      // No matching cache yet: store non-username fields from Logto so /api/me still works.
    }
  }

  return await persistSyncedUserProfile({
    userUuid: input.user.uuid,
    logtoUserId: input.logtoUserId,
    fields,
    stored,
  });
}

/**
 * Ensure a profile through either a verified user token or a previously verified binding.
 * Principals without either identity return a transient profile and never create a guessed binding.
 */
export async function ensureCurrentUserProfile(user: AuthUser): Promise<UserProfile> {
  const stored = await getStoredUserProfile(user.uuid);
  const tokenLogtoUserId = typeof user.sub === "string" && user.sub.trim() ? user.sub.trim() : null;
  const logtoUserId = resolveTrustedLogtoUserId({
    userUuid: user.uuid,
    tokenLogtoUserId,
    storedLogtoUserId: stored?.logtoUserId,
  });

  if (!logtoUserId) return transientUserProfile(user, stored);
  if (!tokenLogtoUserId && stored?.username) return stored;

  return await syncUserProfileFromLogto({ user, logtoUserId, stored });
}

/** Ensure a durable profile exists before creating resources owned by the user. */
export async function ensurePersistedCurrentUserProfile(user: AuthUser): Promise<UserProfile> {
  const profile = await ensureCurrentUserProfile(user);
  if (!profile.logtoUserId) {
    throw new LogtoUserRequiredError("profile provisioning requires user sign-in");
  }
  return profile;
}

/** Ensure a profile for a resource owner, optionally using a verified actor identity hint. */
export async function ensureUserProfileByUuid(
  userUuid: string,
  actor?: AuthUser | null,
): Promise<UserProfile | null> {
  const ownerActor = actor?.uuid === userUuid ? actor : null;
  const stored = await getStoredUserProfile(userUuid);
  const tokenLogtoUserId = typeof ownerActor?.sub === "string" && ownerActor.sub.trim()
    ? ownerActor.sub.trim()
    : null;
  const logtoUserId = resolveTrustedLogtoUserId({
    userUuid,
    tokenLogtoUserId,
    storedLogtoUserId: stored?.logtoUserId,
  });

  if (!logtoUserId) return null;
  if (!tokenLogtoUserId && stored?.username) return stored;

  const user = ownerActor ?? ({ uuid: userUuid } as AuthUser);
  return await syncUserProfileFromLogto({ user, logtoUserId, stored });
}

export async function updateCurrentUserProfile(user: AuthUser, input: { displayName?: string; avatarUrl?: string | null; username?: string | null }) {
  // Logto access tokens carry `sub`; execution / work / preview principals only have
  // actor uuid, so fall back to the stored profile's logtoUserId for those cases.
  const logtoUserIdFromToken = typeof user.sub === "string" && user.sub.trim() ? user.sub.trim() : null;
  const storedProfile = await getStoredUserProfile(user.uuid);
  const logtoUserId = resolveTrustedLogtoUserId({
    userUuid: user.uuid,
    tokenLogtoUserId: logtoUserIdFromToken,
    storedLogtoUserId: storedProfile?.logtoUserId,
  });
  if (!logtoUserId) throw new LogtoUserRequiredError("profile updates require user sign-in");

  const username = input.username === undefined ? undefined : normalizeUsername(input.username);
  if (input.username !== undefined && input.username !== null && !username) {
    throw new Error("invalid username");
  }

  const trustedStoredProfile = storedProfile?.logtoUserId === logtoUserId ? storedProfile : null;
  const previousLogtoUser = await getLogtoUser(logtoUserId);
  const previousFields = normalizeUserProfile({ userUuid: user.uuid, source: previousLogtoUser });
  const previousUsername = trustedStoredProfile?.username ?? previousFields.username;
  if (
    username &&
    username !== trustedStoredProfile?.username &&
    validatePublicIdentifierAssignment("username", username).reason === "reserved"
  ) {
    throw new UsernameReservedError("This username is reserved.");
  }
  if (input.username !== undefined && !username && previousUsername) {
    throw new UsernameClearError("username cannot be cleared once set");
  }

  if (username && username !== trustedStoredProfile?.username) {
    const existing = await db.select({ userUuid: userProfiles.userUuid }).from(userProfiles).where(
      and(eq(userProfiles.username, username), ne(userProfiles.userUuid, user.uuid)),
    ).limit(1);
    if (existing.length > 0) {
      throw new UsernameConflictError("username is already taken");
    }
    if (trustedStoredProfile?.username) {
      const nextAllowedAt = await nextUsernameChangeAt(user.uuid);
      if (nextAllowedAt) throw new UsernameChangeTooSoonError(nextAllowedAt);
    }
  }

  await updateLogtoUserProfile(logtoUserId, {
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    username: username === undefined ? undefined : username,
  });

  try {
    const updated = await getLogtoUser(logtoUserId);
    const rawUpdatedFields = normalizeUserProfile({ userUuid: user.uuid, source: updated });
    let updatedFields = normalizeSyncedUserProfile({
      userUuid: user.uuid,
      source: updated,
      historicalUsername: trustedStoredProfile?.username,
    });
    if (rawUpdatedFields.username && !updatedFields.username) {
      updatedFields = await assignDefaultUsernameViaLogto({
        userUuid: user.uuid,
        logtoUserId,
        fields: updatedFields,
        stored: trustedStoredProfile,
      });
    }
    return await upsertUserProfile({
      userUuid: user.uuid,
      logtoUserId,
      fields: updatedFields,
      limitUsernameChange: username !== undefined,
    });
  } catch (error) {
    // A concurrent rename may have committed meanwhile; restore Logto to the committed local username.
    const committedUsername = (await getStoredUserProfile(user.uuid).catch(() => null))?.username;
    await updateLogtoUserProfile(logtoUserId, {
      displayName: previousFields.displayName,
      avatarUrl: previousFields.avatarUrl,
      username: committedUsername ?? previousFields.username,
    }).catch((rollbackError) => {
      logger.warn("[user-profile] Failed to roll back Logto profile after local update failure:", rollbackError);
    });
    throw error;
  }
}

export async function getProfilesByUuids(userUuids: string[]): Promise<Map<string, PublicUserProfile>> {
  const unique = [...new Set(userUuids.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) return new Map();

  const rows = await db.select().from(userProfiles).where(inArray(userProfiles.userUuid, unique));
  return new Map(rows.map((row) => [row.userUuid, toPublicUserProfile(row)]));
}

export async function getProfilesByUsernames(usernames: string[]): Promise<Map<string, PublicUserProfile>> {
  const unique = [...new Set(usernames.map((value) => normalizeUsername(value)).filter((value): value is string => Boolean(value)))];
  if (unique.length === 0) return new Map();

  const rows = await db.select().from(userProfiles).where(inArray(userProfiles.username, unique));
  return new Map(rows
    .filter((row): row is typeof row & { username: string } => Boolean(row.username))
    .map((row) => [row.username, toPublicUserProfile(row)]));
}

export function fallbackPublicUserProfile(userUuid: string): PublicUserProfile {
  return {
    userUuid,
    username: null,
    displayName: fallbackDisplayName(userUuid),
    avatarUrl: null,
  };
}
