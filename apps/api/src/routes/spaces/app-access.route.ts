import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { apps, appViewerGrants, userProfiles } from "@cohub/db";
import { readOfflineScopes, withOfflineScopes } from "@cohub/core/apps";
import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";
import { db } from "../../db/index.js";
import { authzDenied, getExecutionPrincipal, requireValidId, useAccountPrincipal } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import { fallbackPublicUserProfile } from "../../user-profiles.js";

/** Apps a member gave offline access to this Space: what they may do while nobody is present. */
const router = new Hono();

const offlineGrants = (spaceId: string) => and(
  eq(appViewerGrants.spaceId, spaceId),
  isNull(appViewerGrants.revokedAt),
  sql`jsonb_array_length(coalesce(${appViewerGrants.meta} -> 'offlineScopes', '[]'::jsonb)) > 0`,
);

router.get("/", async (c) => {
  if (getExecutionPrincipal(c)?.source === APP_ACTION_EXECUTION_SOURCE) return authzDenied(c);
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "member.view", { spaceId }))) return authzDenied(c);
  const rows = await db
    .select({
      grantId: appViewerGrants.id,
      meta: appViewerGrants.meta,
      updatedAt: appViewerGrants.updatedAt,
      viewerUserUuid: appViewerGrants.viewerUserUuid,
      app: { id: apps.id, slug: apps.slug, meta: apps.meta },
      profile: { userUuid: userProfiles.userUuid, username: userProfiles.username, displayName: userProfiles.displayName, avatarUrl: userProfiles.avatarUrl },
    })
    .from(appViewerGrants)
    .innerJoin(apps, eq(apps.id, appViewerGrants.appId))
    .leftJoin(userProfiles, eq(userProfiles.userUuid, appViewerGrants.viewerUserUuid))
    .where(offlineGrants(spaceId))
    .orderBy(desc(appViewerGrants.updatedAt));
  return c.json({
    items: rows.map((row) => ({
      grantId: row.grantId,
      app: { id: row.app.id, slug: row.app.slug, title: appTitle(row.app.meta) },
      grantedBy: row.profile?.userUuid ? row.profile : fallbackPublicUserProfile(row.viewerUserUuid),
      scopes: readOfflineScopes(row.meta),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    })),
  });
});

/** Ends offline access only; the member's own interactive grant stays as they left it. */
router.delete("/:grantId", async (c) => {
  if (getExecutionPrincipal(c)?.source === APP_ACTION_EXECUTION_SOURCE) return authzDenied(c);
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const grantId = c.req.param("grantId");
  if (!spaceId || !requireValidId(spaceId) || !requireValidId(grantId)) return c.json({ message: "grant not found" }, 404);
  const [grant] = await db
    .select({ id: appViewerGrants.id, meta: appViewerGrants.meta, viewerUserUuid: appViewerGrants.viewerUserUuid })
    .from(appViewerGrants)
    .where(and(eq(appViewerGrants.id, grantId), offlineGrants(spaceId)))
    .limit(1);
  if (!grant) return c.json({ message: "grant not found" }, 404);
  if (grant.viewerUserUuid !== user.uuid && !(await hasPermission(user, "member.manage", { spaceId }))) return authzDenied(c);
  await db.update(appViewerGrants)
    .set({ meta: withOfflineScopes(grant.meta, []), updatedAt: new Date() })
    .where(eq(appViewerGrants.id, grant.id));
  return c.body(null, 204);
});

function appTitle(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const { title, name } = meta as { title?: unknown; name?: unknown };
  const value = typeof title === "string" && title.trim() ? title : typeof name === "string" ? name : "";
  return value.trim() || null;
}

export default router;
