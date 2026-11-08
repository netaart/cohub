import { Hono } from "hono";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { accessPolicies, spaces, userProfiles, apps } from "@cohub/db";
import { readAppPageFields, appTitleFromMeta } from "@cohub/core/apps";
import { db } from "../db/index.js";
import { getSpacePublicProfile, requireValidId, useAuth } from "../lib/middleware.js";
import { createAppPublicUrl } from "../lib/app-public-url.js";
import {
  getProfilesByUuids,
  normalizeUsername,
} from "../user-profiles.js";
import { redirectTarget, resolveOwnerByUsername } from "../slug-history.js";

const router = new Hono();

const MAX_BATCH_USER_PROFILES = 100;
const MAX_PUBLIC_USER_SPACES = 50;
const MAX_PUBLIC_USER_WORKS = 50;
const PUBLIC_USER_HTTP_CACHE = "public, max-age=60, stale-while-revalidate=300";

type BatchProfilesBody = {
  userUuids?: unknown;
};

const isDiscoverableSpacePolicy = or(
  eq(accessPolicies.anonymousUserRole, "guest"),
  eq(accessPolicies.signedInUserRole, "guest"),
  eq(accessPolicies.signedInUserRole, "builder"),
);

router.post("/profiles/batch", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const body = await c.req.json<BatchProfilesBody>().catch(() => null);
  if (!body || !Array.isArray(body.userUuids)) {
    return c.json({ message: "userUuids must be an array" }, 400);
  }

  const userUuidSet = new Set<string>();
  for (const value of body.userUuids) {
    if (typeof value !== "string") {
      return c.json({ message: "userUuids must contain only strings" }, 400);
    }

    const userUuid = value.trim();
    if (!requireValidId(userUuid)) {
      return c.json({ message: "userUuids contains an invalid id" }, 400);
    }

    userUuidSet.add(userUuid);
  }

  const uniqueUserUuids = [...userUuidSet];
  if (uniqueUserUuids.length > MAX_BATCH_USER_PROFILES) {
    return c.json({ message: `userUuids must contain at most ${MAX_BATCH_USER_PROFILES} unique items` }, 400);
  }
  const profileMap = await getProfilesByUuids(uniqueUserUuids);
  const profiles = Object.fromEntries(profileMap);
  const missingUserUuids = uniqueUserUuids.filter((userUuid) => !profileMap.has(userUuid));

  c.header("Cache-Control", "private, max-age=60, stale-while-revalidate=300");
  return c.json({ profiles, missingUserUuids });
});

// Public guest profile page — anonymous readable, only discoverable resources.
router.get("/by-username/:username", async (c) => {
  const username = normalizeUsername(c.req.param("username"));
  if (!username) return c.json({ message: "user not found" }, 404);

  const owner = await resolveOwnerByUsername(username);
  if (!owner) return c.json({ message: "user not found" }, 404);
  const profile = {
    userUuid: owner.profile.userUuid,
    username: owner.profile.username,
    displayName: owner.profile.displayName,
    avatarUrl: owner.profile.avatarUrl ?? null,
  };
  const ownerUsername = profile.username;

  // Discoverable spaces only: join access policy + limit in SQL.
  const discoverableSpaces = await db
    .select({
      id: spaces.id,
      slug: spaces.slug,
      name: spaces.name,
      description: spaces.description,
      meta: spaces.meta,
      updatedAt: spaces.updatedAt,
      lastActivityAt: spaces.lastActivityAt,
      createdAt: spaces.createdAt,
      anonymousUserRole: accessPolicies.anonymousUserRole,
    })
    .from(spaces)
    .innerJoin(
      accessPolicies,
      and(
        eq(accessPolicies.resourceType, "space"),
        eq(accessPolicies.resourceId, spaces.id),
      ),
    )
    .where(and(
      eq(spaces.userUuid, profile.userUuid),
      isDiscoverableSpacePolicy,
    ))
    .orderBy(
      desc(sql`coalesce(${spaces.lastActivityAt}, ${spaces.updatedAt}, ${spaces.createdAt})`),
      desc(spaces.createdAt),
    )
    .limit(MAX_PUBLIC_USER_SPACES);

  const publicSpaces = discoverableSpaces.map((space) => {
    const publicProfile = getSpacePublicProfile(space);
    const slug = space.slug ?? null;
    return {
      id: space.id,
      slug,
      name: space.name,
      description: space.description ?? null,
      publicProfile,
      accessLabel: space.anonymousUserRole === "guest"
        ? ("public" as const)
        : ("sign-in-required" as const),
      spaceUrl: slug
        ? `/${encodeURIComponent(ownerUsername)}/${encodeURIComponent(slug)}`
        : `/spaces/${space.id}`,
      updatedAt: (space.lastActivityAt ?? space.updatedAt)?.toISOString() ?? null,
    };
  });

  // Works this user published (own spaces + collaborator spaces).
  // Public URL always uses the space owner's username.
  const workRows = await db
    .select({
      id: apps.id,
      slug: apps.slug,
      meta: apps.meta,
      publishedAt: apps.publishedAt,
      updatedAt: apps.updatedAt,
      spaceSlug: spaces.slug,
      spaceName: spaces.name,
      spaceOwnerUsername: userProfiles.username,
    })
    .from(apps)
    .innerJoin(spaces, eq(spaces.id, apps.spaceId))
    .innerJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(and(
      eq(apps.userUuid, profile.userUuid),
      eq(apps.status, "published"),
      eq(apps.visibility, "public"),
      sql`${spaces.slug} is not null`,
      sql`${userProfiles.username} is not null`,
    ))
    .orderBy(
      desc(sql`coalesce(${apps.publishedAt}, ${apps.updatedAt})`),
      desc(apps.createdAt),
    )
    .limit(MAX_PUBLIC_USER_WORKS);

  const publicWorks = workRows
    .filter((row): row is typeof row & { spaceSlug: string; spaceOwnerUsername: string } =>
      Boolean(row.spaceSlug && row.spaceOwnerUsername))
    .map((row) => {
      const page = readAppPageFields(row.meta);
      return {
        id: row.id,
        slug: row.slug,
        title: appTitleFromMeta(row.meta, row.slug),
        description: page.description,
        icon: page.icon,
        spaceSlug: row.spaceSlug,
        spaceName: row.spaceName,
        publicUrl: createAppPublicUrl({
          ownerUsername: row.spaceOwnerUsername,
          spaceSlug: row.spaceSlug,
          appSlug: row.slug,
        }),
        publishedAt: row.publishedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt?.toISOString() ?? null,
      };
    });

  c.header("Cache-Control", PUBLIC_USER_HTTP_CACHE);
  return c.json({
    profile,
    spaces: publicSpaces,
    apps: publicWorks,
    ...(owner.redirected
      ? { redirectTo: redirectTarget(c.req.url, `/${encodeURIComponent(ownerUsername)}`) }
      : {}),
  });
});

export default router;
