import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { normalizePublicAvatarUrl, useAuth } from "../lib/middleware.js";
import { createLogger } from "@cohub/infra/logging";
import { asAccountIdentity, hasPermission } from "../permissions.js";
import { listRecentSpaces, parseSpaceVisits, RECENT_SPACE_LIMIT } from "../space-list.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

const DEFAULT_SESSION_LIMIT = 20;
const MAX_SESSION_LIMIT = 50;

type PaletteOverviewSessionRow = {
  id: string;
  spaceId: string;
  spaceName: string | null;
  title: string | null;
  viewerRelation: "creator" | "participant";
  lastMessageAt: Date | string | null;
  updatedAt: Date | string | null;
};

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
  const sessionLimit = clampLimit(c.req.query("sessionLimit"), DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT);
  const visits = parseSpaceVisits(c.req.queries("recentSpaceId") ?? [], c.req.queries("recentSpaceAt") ?? [], new Date());

  try {
    const [spaceRows, sessionRows] = await Promise.all([
      listRecentSpaces(identity.uuid, visits, spaceLimit),
      db.execute<PaletteOverviewSessionRow>(sql`
        SELECT
          sess.id,
          sess.space_id AS "spaceId",
          s.name AS "spaceName",
          nullif(sess.title, '') AS title,
          CASE WHEN sess.user_uuid = ${identity.uuid} THEN 'creator' ELSE 'participant' END AS "viewerRelation",
          sess.last_message_at AS "lastMessageAt",
          coalesce(sess.last_message_at, sess.updated_at, sess.created_at) AS "updatedAt"
        FROM v2.space_sessions sess
        JOIN v2.spaces s ON s.id = sess.space_id
        LEFT JOIN v2.space_members sm
          ON sm.space_id = s.id AND sm.user_id = ${identity.uuid}
        WHERE
          (sess.user_uuid = ${identity.uuid}
            OR (sess.meta -> 'participants' -> 'userUuids') ? ${identity.uuid})
          AND (
            s.user_uuid = ${identity.uuid}
            OR sm.user_id IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM v2.access_policies ap
              WHERE ap.resource_type = 'space'
                AND ap.resource_id = s.id
                AND (ap.signed_in_user_role IS NOT NULL OR ap.anonymous_user_role IS NOT NULL)
            )
          )
        ORDER BY
          coalesce(sess.last_message_at, sess.updated_at, sess.created_at) DESC,
          sess.id ASC
        LIMIT ${sessionLimit}
      `),
    ]);

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
      recentSessions: sessionRows.map((row) => ({
        id: row.id,
        spaceId: row.spaceId,
        spaceName: row.spaceName,
        title: row.title,
        viewerRelation: row.viewerRelation,
        lastMessageAt: toIso(row.lastMessageAt),
        updatedAt: toIso(row.updatedAt),
      })),
    });
  } catch (error) {
    logger.warn("[palette-overview] failed", { userUuid: identity.uuid, error });
    // Keep failures distinguishable from a legitimate empty account. The
    // client can retain its last-known-good snapshot and use local caches.
    return c.json(
      {
        generatedAt: new Date().toISOString(),
        spaces: [],
        recentSessions: [],
        degraded: true,
      },
      503,
    );
  }
});

export default router;
