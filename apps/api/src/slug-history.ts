import { and, desc, eq, sql } from "drizzle-orm";
import { slugHistory, spaces, userProfiles } from "@cohub/db";
import { db } from "./db/index.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Transaction;
type UserProfileRow = typeof userProfiles.$inferSelect;
type SpaceRow = typeof spaces.$inferSelect;

const USERNAME_CHANGE_INTERVAL_MS = 12 * 60 * 60 * 1000;

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
  await tx.insert(slugHistory).values({
    entityType: "space",
    entityId: space.id,
    ownerUuid: space.userUuid,
    oldSlug,
  });
}

export type ResolvedOwner = { profile: UserProfileRow & { username: string }; redirected: boolean };

/**
 * Current holders always win; old names can be claimed by anyone at any time. Only an
 * unclaimed name falls back to history, following whoever gave it up most recently.
 */
export async function resolveOwnerByUsername(username: string): Promise<ResolvedOwner | null> {
  const [current] = await db.select().from(userProfiles).where(eq(userProfiles.username, username)).limit(1);
  if (current?.username) return { profile: { ...current, username: current.username }, redirected: false };

  const [latest] = await db
    .select({ profile: userProfiles })
    .from(slugHistory)
    .leftJoin(userProfiles, eq(userProfiles.userUuid, slugHistory.entityId))
    .where(and(eq(slugHistory.entityType, "username"), eq(slugHistory.oldSlug, username)))
    .orderBy(desc(slugHistory.createdAt))
    .limit(1);
  const profile = latest?.profile;
  return profile?.username ? { profile: { ...profile, username: profile.username }, redirected: true } : null;
}

async function resolveOwnedSpace(ownerUuid: string, slug: string): Promise<{ space: SpaceRow; redirected: boolean } | null> {
  const [current] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.userUuid, ownerUuid), eq(spaces.slug, slug)))
    .limit(1);
  if (current) return { space: current, redirected: false };

  // Spaces are hard-deleted: when the latest holder is gone the address 404s instead of
  // falling back to an older holder.
  const [latest] = await db
    .select({ space: spaces })
    .from(slugHistory)
    .leftJoin(spaces, and(
      eq(spaces.id, sql`${slugHistory.entityId}::uuid`),
      eq(spaces.userUuid, ownerUuid),
    ))
    .where(and(
      eq(slugHistory.entityType, "space"),
      eq(slugHistory.ownerUuid, ownerUuid),
      eq(slugHistory.oldSlug, slug),
    ))
    .orderBy(desc(slugHistory.createdAt))
    .limit(1);
  return latest?.space?.slug ? { space: latest.space, redirected: true } : null;
}

export type ResolvedPublicSpace = {
  owner: UserProfileRow & { username: string };
  space: SpaceRow & { slug: string };
  redirected: boolean;
};

/** Resolve `/:username/:spaceSlug`, following old names on both segments in one step. */
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
