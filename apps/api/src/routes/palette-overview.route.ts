import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../user-profiles.js";
import { normalizePublicAvatarUrl, useAuth } from "../lib/middleware.js";
import { createLogger } from "@cohub/infra/logging";
import { isUuid } from "@cohub/protocol/identifiers";
import { asAccountIdentity, hasPermission } from "../permissions.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

const DEFAULT_SPACE_LIMIT = 50;
const MAX_SPACE_LIMIT = 100;
const DEFAULT_SESSION_LIMIT = 20;
const MAX_SESSION_LIMIT = 50;
const MAX_RECENT_SPACE_IDS = 10;

type PaletteSpaceRelation = "owner" | "member" | "public";

type PaletteOverviewSpaceRow = {
  id: string;
  name: string | null;
  description: string | null;
  ownerUserUuid: string | null;
  avatarUrl: string | null;
  spaceRelation: PaletteSpaceRelation;
  isPinned: boolean;
  isArchived: boolean;
  lastParticipatedAt: Date | string | null;
  updatedAt: Date | string | null;
};

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

/**
 * Command palette default (empty-query) list data.
 *
 * Serves only the palette surface: viewer-relative space signals (pin, relation,
 * personal participation time) plus recently creator/participant sessions. All
 * aggregation is scoped to the requesting user's own turns, so cost grows with
 * the user's history, not with global activity.
 */
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

  const spaceLimit = clampLimit(c.req.query("spaceLimit"), DEFAULT_SPACE_LIMIT, MAX_SPACE_LIMIT);
  const sessionLimit = clampLimit(c.req.query("sessionLimit"), DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT);
  const recentSpaceIds = [
    ...new Set(
      (c.req.queries("recentSpaceId") ?? [])
        .map((value) => value.trim())
        .filter((value) => isUuid(value)),
    ),
  ].slice(0, MAX_RECENT_SPACE_IDS);
  const recentSpaceCondition =
    recentSpaceIds.length > 0
      ? sql`s.id IN (${sql.join(recentSpaceIds.map((id) => sql`${id}::uuid`), sql`, `)})`
      : sql`1 = 0`;

  try {
    const { spaceRows, sessionRows } = await db.transaction(async (tx) => {
      const spaces = await tx.execute<PaletteOverviewSpaceRow>(sql`
        WITH visible_spaces AS MATERIALIZED (
          SELECT
            s.id,
            s.name,
            s.description,
            s.user_uuid AS owner_user_uuid,
            s.meta,
            s.last_activity_at,
            s.updated_at,
            s.created_at,
            pinned_assignment.id IS NOT NULL AS is_pinned,
            archive_assignment.id IS NOT NULL AS is_archived,
            (${recentSpaceCondition}) AS is_local_recent,
            CASE
              WHEN s.user_uuid = ${identity.uuid} THEN 'owner'
              WHEN sm.user_id IS NOT NULL THEN 'member'
              ELSE 'public'
            END AS space_relation
          FROM v2.spaces s
          LEFT JOIN v2.space_members sm
            ON sm.space_id = s.id AND sm.user_id = ${identity.uuid}
          LEFT JOIN v2.labels pinned_label
            ON pinned_label.scope_type = 'user'
            AND pinned_label.scope_id = ${identity.uuid}
            AND pinned_label.system_key = 'user:pinned'
          LEFT JOIN v2.label_assignments pinned_assignment
            ON pinned_assignment.label_id = pinned_label.id
            AND pinned_assignment.scope_type = 'user'
            AND pinned_assignment.scope_id = ${identity.uuid}
            AND pinned_assignment.resource_type = 'space'
            AND pinned_assignment.resource_ref = s.id::text
          LEFT JOIN v2.labels archive_label
            ON archive_label.scope_type = 'user'
            AND archive_label.scope_id = ${identity.uuid}
            AND archive_label.system_key = 'user:archived'
          LEFT JOIN v2.label_assignments archive_assignment
            ON archive_assignment.label_id = archive_label.id
            AND archive_assignment.scope_type = 'user'
            AND archive_assignment.scope_id = ${identity.uuid}
            AND archive_assignment.resource_type = 'space'
            AND archive_assignment.resource_ref = s.id::text
          WHERE
            (s.user_uuid = ${identity.uuid}
            OR sm.user_id IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM v2.access_policies ap
              WHERE ap.resource_type = 'space'
                AND ap.resource_id = s.id
                AND (ap.signed_in_user_role IS NOT NULL OR ap.anonymous_user_role IS NOT NULL)
            ))
            AND archive_assignment.id IS NULL
        ),
        user_turn_activity AS (
          SELECT
            sess.space_id AS space_id,
            MAX(t.created_at) AS last_participated_at
          FROM v2.session_turns t
          JOIN v2.space_sessions sess ON sess.id = t.session_id
          JOIN visible_spaces visible ON visible.id = sess.space_id
          WHERE t.user_uuid = ${identity.uuid}
          GROUP BY sess.space_id
        )
        SELECT
          vs.id,
          vs.name,
          CASE
            WHEN coalesce(vs.description, '') = '' THEN NULL::text
            ELSE left(regexp_replace(vs.description, '\\s+', ' ', 'g'), 220)
          END AS description,
          vs.owner_user_uuid AS "ownerUserUuid",
          nullif(trim(coalesce(vs.meta #>> '{publicProfile,avatarUrl}', '')), '') AS "avatarUrl",
          vs.space_relation AS "spaceRelation",
          vs.is_pinned AS "isPinned",
          vs.is_archived AS "isArchived",
          uta.last_participated_at AS "lastParticipatedAt",
          coalesce(vs.last_activity_at, vs.updated_at, vs.created_at) AS "updatedAt"
        FROM visible_spaces vs
        LEFT JOIN user_turn_activity uta ON uta.space_id = vs.id
        ORDER BY
          vs.is_local_recent DESC,
          uta.last_participated_at DESC NULLS LAST,
          CASE
            WHEN vs.space_relation = 'owner' THEN 0
            WHEN vs.space_relation = 'member' THEN 1
            ELSE 2
          END ASC,
          coalesce(vs.last_activity_at, vs.updated_at, vs.created_at) DESC,
          vs.id ASC
        LIMIT ${spaceLimit}
      `);

      const sessions = await tx.execute<PaletteOverviewSessionRow>(sql`
        SELECT
          sess.id,
          sess.space_id AS "spaceId",
          s.name AS "spaceName",
          coalesce(nullif(sess.title, ''), 'Untitled session') AS title,
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
      `);

      return { spaceRows: spaces, sessionRows: sessions };
    });

    let profileMap = new Map<string, ReturnType<typeof fallbackPublicUserProfile>>();
    try {
      profileMap = await getProfilesByUuids(
        spaceRows.filter((row) => row.ownerUserUuid).map((row) => row.ownerUserUuid as string),
      );
    } catch (error) {
      logger.warn("[palette-overview] profile enrichment failed", {
        userUuid: identity.uuid,
        ownerCount: new Set(spaceRows.map((row) => row.ownerUserUuid).filter(Boolean)).size,
        error,
      });
    }

    return c.json({
      generatedAt: new Date().toISOString(),
      degraded: false,
      spaces: spaceRows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        ownerProfile: row.ownerUserUuid
          ? (profileMap.get(row.ownerUserUuid) ?? fallbackPublicUserProfile(row.ownerUserUuid))
          : null,
        spaceProfile: { avatarUrl: normalizePublicAvatarUrl(row.avatarUrl) },
        isPinned: Boolean(row.isPinned),
        isArchived: Boolean(row.isArchived),
        relation: row.spaceRelation,
        lastParticipatedAt: toIso(row.lastParticipatedAt),
        updatedAt: toIso(row.updatedAt),
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
