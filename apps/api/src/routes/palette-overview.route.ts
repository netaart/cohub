import { Hono } from "hono";
import { normalizePublicAvatarUrl, useAuth } from "../lib/middleware.js";
import { createLogger } from "@cohub/infra/logging";
import { asAccountIdentity, hasPermission } from "../permissions.js";
import { listRecentSpaces, parseSpaceVisits, RECENT_SPACE_LIMIT } from "../space-list.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

function clampLimit(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), max);
}

function toIso(value: Date | string | null) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.space.list", { spaceId: "" }))) {
    return c.json({ message: "forbidden" }, 403);
  }
  const identity = asAccountIdentity(user);
  if (!identity) return c.json({ message: "forbidden" }, 403);
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Authorization, Cookie");

  const spaceLimit = clampLimit(c.req.query("spaceLimit"), RECENT_SPACE_LIMIT, RECENT_SPACE_LIMIT);
  const visits = parseSpaceVisits(c.req.queries("recentSpaceId") ?? [], c.req.queries("recentSpaceAt") ?? [], new Date());

  try {
    const spaceRows = await listRecentSpaces(identity.uuid, visits, spaceLimit);

    return c.json({
      generatedAt: new Date().toISOString(),
      degraded: false,
      spaces: spaceRows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        ownerProfile: {
          userUuid: row.user_uuid,
          username: row.owner_username,
          displayName: row.owner_display_name,
          avatarUrl: normalizePublicAvatarUrl(row.owner_avatar_url),
        },
        spaceProfile: { avatarUrl: normalizePublicAvatarUrl(row.avatar_url) },
        isPinned: row.is_pinned,
        isArchived: row.is_archived,
        relation: row.user_uuid === identity.uuid ? "owner" : "member",
        lastParticipatedAt: toIso(row.sort_at),
        updatedAt: toIso(row.last_activity_at ?? row.updated_at ?? row.created_at),
      })),
    });
  } catch (error) {
    logger.warn("[palette-overview] failed", { userUuid: identity.uuid, error });
    // Degraded, not empty: clients keep their last good snapshot.
    return c.json(
      {
        generatedAt: new Date().toISOString(),
        spaces: [],
        degraded: true,
      },
      503,
    );
  }
});

export default router;
