import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { apps, appViewerGrants, userProfiles } from "@cohub/db";
import { appTitleFromMeta, hasOfflineScopes, readOfflineScopes, withOfflineScopes } from "@cohub/core/apps";
import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";
import { db } from "../../db/index.js";
import { authzDenied, getExecutionPrincipal, requireValidId, useAccountPrincipal } from "../../lib/middleware.js";
import { getRoleForSpaceUser, hasPermission } from "../../permissions.js";
import { fallbackPublicUserProfile } from "../../user-profiles.js";

/** Apps a member gave offline access to this Space: what they may do while nobody is present. */
const router = new Hono();

const offlineGrants = (spaceId: string) => and(
  eq(appViewerGrants.spaceId, spaceId),
  isNull(appViewerGrants.revokedAt),
  hasOfflineScopes,
);

router.get("/", async (c) => {
  if (getExecutionPrincipal(c)?.source === APP_ACTION_EXECUTION_SOURCE) return authzDenied(c);
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  // Members see every App's access; anyone else sees only what they granted.
  const member = (await getRoleForSpaceUser(spaceId, user.uuid)) !== null;
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
    .where(and(offlineGrants(spaceId), member ? undefined : eq(appViewerGrants.viewerUserUuid, user.uuid)))
    .orderBy(desc(appViewerGrants.updatedAt));
  return c.json({
    items: rows.map((row) => ({
      grantId: row.grantId,
      app: { id: row.app.id, slug: row.app.slug, title: appTitleFromMeta(row.app.meta, row.app.slug) },
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

export default router;
