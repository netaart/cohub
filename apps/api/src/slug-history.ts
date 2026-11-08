import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { slugHistory, spaces, userProfiles } from "@cohub/db";
import { HOME_SPACE_SLUG } from "@cohub/protocol/public-identifiers";
import { db } from "./db/index.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Transaction;
type UserProfileRow = typeof userProfiles.$inferSelect;
type SpaceRow = typeof spaces.$inferSelect;

const USERNAME_CHANGE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const USERNAME_HISTORY_UNIQUE = "v2_uq_slug_history_username";
export const SPACE_SLUG_HISTORY_UNIQUE = "v2_uq_slug_history_space";

export async function retiredUsernames(candidates: string[], executor: Executor = db): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await executor
    .select({ oldSlug: slugHistory.oldSlug })
    .from(slugHistory)
    .where(and(
      eq(slugHistory.entityType, "username"),
      inArray(slugHistory.oldSlug, candidates),
    ));
  return new Set(rows.map((row) => row.oldSlug));
}

export async function isUsernameRetired(username: string, executor: Executor = db): Promise<boolean> {
  return (await retiredUsernames([username], executor)).has(username);
}

/** Home stays claimable by its owner: the product re-creates it under its system slug on demand. */
export async function isSpaceSlugRetired(ownerUuid: string, slug: string): Promise<boolean> {
  if (slug === HOME_SPACE_SLUG) return false;
  const [row] = await db
    .select({ id: slugHistory.id })
    .from(slugHistory)
    .where(and(
      eq(slugHistory.entityType, "space"),
      eq(slugHistory.ownerUuid, ownerUuid),
      eq(slugHistory.oldSlug, slug),
    ))
    .limit(1);
  return Boolean(row);
}

/** Null when the user may rename now; the first rename (no history) is never limited. */
export async function nextUsernameChangeAt(userUuid: string, executor: Executor = db): Promise<Date | null> {
  const [last] = await executor
    .select({ createdAt: slugHistory.createdAt })
    .from(slugHistory)
    .where(and(eq(slugHistory.entityType, "username"), eq(slugHistory.entityId, userUuid)))
    .orderBy(desc(slugHistory.createdAt))
    .limit(1);
  if (!last) return null;
  const next = new Date(last.createdAt.getTime() + USERNAME_CHANGE_INTERVAL_MS);
  return next.getTime() > Date.now() ? next : null;
}

export async function recordUsernameChange(tx: Transaction, userUuid: string, oldUsername: string) {
  await tx.insert(slugHistory).values({ entityType: "username", entityId: userUuid, oldSlug: oldUsername });
}

export async function recordSpaceSlugChange(tx: Transaction, space: Pick<SpaceRow, "id" | "userUuid">, oldSlug: string) {
  const insert = tx.insert(slugHistory).values({
    entityType: "space",
    entityId: space.id,
    ownerUuid: space.userUuid,
    oldSlug,
  });
  if (oldSlug !== HOME_SPACE_SLUG) {
    await insert;
    return;
  }
  // A reclaimed Home can be renamed again; its old address follows the latest former Home.
  await insert.onConflictDoUpdate({
    target: [slugHistory.ownerUuid, slugHistory.oldSlug],
    targetWhere: sql`${slugHistory.entityType} = 'space' and ${slugHistory.ownerUuid} is not null`,
    set: { entityId: space.id, createdAt: sql`now()` },
  });
}

export type ResolvedOwner = { profile: UserProfileRow & { username: string }; redirected: boolean };

export async function resolveOwnerByUsername(username: string): Promise<ResolvedOwner | null> {
  const [current] = await db.select().from(userProfiles).where(eq(userProfiles.username, username)).limit(1);
  if (current?.username) return { profile: { ...current, username: current.username }, redirected: false };

  const [retired] = await db
    .select({ profile: userProfiles })
    .from(slugHistory)
    .innerJoin(userProfiles, eq(userProfiles.userUuid, slugHistory.entityId))
    .where(and(eq(slugHistory.entityType, "username"), eq(slugHistory.oldSlug, username)))
    .limit(1);
  const currentUsername = retired?.profile.username;
  return retired && currentUsername
    ? { profile: { ...retired.profile, username: currentUsername }, redirected: true }
    : null;
}

async function resolveOwnedSpace(ownerUuid: string, slug: string): Promise<{ space: SpaceRow; redirected: boolean } | null> {
  const [current] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.userUuid, ownerUuid), eq(spaces.slug, slug)))
    .limit(1);
  if (current) return { space: current, redirected: false };

  // Spaces are hard-deleted: the join drops history of removed Spaces so they 404.
  const [retired] = await db
    .select({ space: spaces })
    .from(slugHistory)
    .innerJoin(spaces, and(
      eq(spaces.id, sql`${slugHistory.entityId}::uuid`),
      eq(spaces.userUuid, ownerUuid),
    ))
    .where(and(
      eq(slugHistory.entityType, "space"),
      eq(slugHistory.ownerUuid, ownerUuid),
      eq(slugHistory.oldSlug, slug),
    ))
    .limit(1);
  return retired?.space.slug ? { space: retired.space, redirected: true } : null;
}

export type ResolvedPublicSpace = {
  owner: UserProfileRow & { username: string };
  space: SpaceRow & { slug: string };
  redirected: boolean;
};

/** Resolve `/:username/:spaceSlug`, following retired slugs on both segments in one step. */
export async function resolvePublicSpace(username: string, slug: string): Promise<ResolvedPublicSpace | null> {
  const owner = await resolveOwnerByUsername(username);
  if (!owner) return null;
  const resolved = await resolveOwnedSpace(owner.profile.userUuid, slug);
  if (!resolved?.space.slug) return null;
  return {
    owner: owner.profile,
    space: { ...resolved.space, slug: resolved.space.slug },
    redirected: owner.redirected || resolved.redirected,
  };
}

export function publicSpacePath(username: string, spaceSlug: string): string {
  return `/${encodeURIComponent(username)}/${encodeURIComponent(spaceSlug)}`;
}

export function publicAppPath(username: string, spaceSlug: string, appSlug: string): string {
  return `${publicSpacePath(username, spaceSlug)}/w/${encodeURIComponent(appSlug)}`;
}

/** Canonical path plus the request's query string, for the `redirectTo` response field. */
export function redirectTarget(requestUrl: string, path: string): string {
  return `${path}${new URL(requestUrl).search}`;
}
