import { sql, type SQL } from "drizzle-orm";
import { buildSearchExcerpt, findSearchMatches, toSearchDisplayText } from "@cohub/protocol";
import { containsSql, substringQualitySql, toIso, type SearchCandidate, type SearchViewerRelation } from "./shared.js";

const MESSAGE_WEIGHT = 0.85;
const TITLE_LIMIT = 120;
const SNIPPET_LEAD = 64;
const SNIPPET_WINDOW = 400;
const MAX_CANDIDATES = 150;

export type ChatSearchInput = {
  viewerUuid: string;
  query: string;
  spaceId: string | null;
  includeMessages: boolean;
  limit: number;
};

export type ChatSearchRow = {
  sessionId: string;
  spaceId: string;
  title: string | null;
  latestMessageText: string | null;
  spaceName: string | null;
  spaceAvatarUrl: string | null;
  updatedAt: Date | string | null;
  isMember: boolean;
  viewerRelation: SearchViewerRelation;
  titleScore: number | null;
  turnId: string | null;
  sequence: number | null;
  turnScore: number | null;
  turnMatches: number | string;
  snippet: string | null;
  snippetClippedStart: boolean | null;
  snippetClippedEnd: boolean | null;
};

/** Outside their Spaces, viewers see a session by its own policy, else the Space policy. */
export function buildChatSearchQuery(input: ChatSearchInput) {
  const { viewerUuid: me, query: q, spaceId } = input;
  const isParticipant = sql`(sess.meta -> 'participants' -> 'userUuids') ? ${me}`;
  const inSpace = (column: SQL) => (spaceId ? sql`AND ${column} = ${spaceId}::uuid` : sql``);
  const messageHits = input.includeMessages
    ? sql`
      SELECT DISTINCT ON (t.session_id)
        t.session_id,
        t.id AS turn_id,
        t.sequence,
        ${substringQualitySql(sql`t.user_text`, q)} AS score,
        count(*) OVER (PARTITION BY t.session_id) AS matches
      FROM scope
      JOIN v2.session_turns t ON t.session_id = scope.id
      WHERE ${containsSql(sql`t.user_text`, q)}
      ORDER BY t.session_id, score DESC, t.sequence DESC`
    : sql`
      SELECT NULL::uuid AS session_id, NULL::uuid AS turn_id, NULL::int AS sequence,
        NULL::double precision AS score, 0::bigint AS matches
      WHERE false`;

  return sql`
    WITH viewer_spaces AS (
      SELECT s.id FROM v2.spaces s WHERE s.user_uuid = ${me} ${inSpace(sql`s.id`)}
      UNION
      SELECT sm.space_id FROM v2.space_members sm WHERE sm.user_id = ${me} ${inSpace(sql`sm.space_id`)}
    ),
    scope AS MATERIALIZED (
      SELECT sess.id, true AS is_member
      FROM v2.space_sessions sess
      WHERE sess.space_id IN (SELECT id FROM viewer_spaces) ${inSpace(sql`sess.space_id`)}
      UNION ALL
      SELECT sess.id, false AS is_member
      FROM v2.space_sessions sess
      WHERE ${spaceId ? sql`sess.space_id = ${spaceId}::uuid` : sql`(sess.user_uuid = ${me} OR ${isParticipant})`}
        AND sess.space_id NOT IN (SELECT id FROM viewer_spaces)
        AND coalesce(
          (SELECT ap.signed_in_user_role IS NOT NULL OR ap.anonymous_user_role IS NOT NULL
            FROM v2.access_policies ap
            WHERE ap.resource_type = 'session' AND ap.resource_id = sess.id),
          (SELECT ap.signed_in_user_role IS NOT NULL OR ap.anonymous_user_role IS NOT NULL
            FROM v2.access_policies ap
            WHERE ap.resource_type = 'space' AND ap.resource_id = sess.space_id),
          false
        )
    ),
    title_hits AS (
      SELECT sess.id AS session_id, ${substringQualitySql(sql`sess.title`, q)} AS score
      FROM scope
      JOIN v2.space_sessions sess ON sess.id = scope.id
      WHERE ${containsSql(sql`sess.title`, q)}
    ),
    message_hits AS (${messageHits}),
    ranked AS (
      SELECT
        sess.id AS session_id,
        sess.space_id,
        sess.title,
        left(sess.latest_message_text, ${TITLE_LIMIT * 2}) AS latest_message_text,
        coalesce(sess.last_message_at, sess.updated_at, sess.created_at) AS updated_at,
        scope.is_member,
        CASE
          WHEN sess.user_uuid = ${me} THEN 'creator'
          WHEN ${isParticipant} THEN 'participant'
          ELSE 'unrelated'
        END AS viewer_relation,
        th.score AS title_score,
        mh.turn_id,
        mh.sequence,
        mh.score AS turn_score,
        coalesce(mh.matches, 0) AS turn_matches
      FROM title_hits th
      FULL JOIN message_hits mh ON mh.session_id = th.session_id
      JOIN scope ON scope.id = coalesce(th.session_id, mh.session_id)
      JOIN v2.space_sessions sess ON sess.id = scope.id
      ORDER BY
        CASE WHEN sess.user_uuid = ${me} OR ${isParticipant} THEN 0 WHEN scope.is_member THEN 1 ELSE 2 END,
        greatest(coalesce(th.score, 0), coalesce(mh.score, 0) * ${MESSAGE_WEIGHT}) DESC,
        coalesce(sess.last_message_at, sess.updated_at, sess.created_at) DESC NULLS LAST,
        sess.id
      LIMIT ${Math.min(input.limit * 3, MAX_CANDIDATES)}
    )
    SELECT
      r.session_id AS "sessionId",
      r.space_id AS "spaceId",
      r.title,
      r.latest_message_text AS "latestMessageText",
      sp.name AS "spaceName",
      sp.meta #>> '{publicProfile,avatarUrl}' AS "spaceAvatarUrl",
      r.updated_at AS "updatedAt",
      r.is_member AS "isMember",
      r.viewer_relation AS "viewerRelation",
      r.title_score AS "titleScore",
      r.turn_id AS "turnId",
      r.sequence,
      r.turn_score AS "turnScore",
      r.turn_matches AS "turnMatches",
      substr(t.user_text, w.start, ${SNIPPET_WINDOW}) AS snippet,
      w.start > 1 AS "snippetClippedStart",
      w.start + ${SNIPPET_WINDOW} <= length(t.user_text) AS "snippetClippedEnd"
    FROM ranked r
    JOIN v2.spaces sp ON sp.id = r.space_id
    LEFT JOIN v2.session_turns t ON t.id = r.turn_id
    LEFT JOIN LATERAL (
      SELECT greatest(1, strpos(lower(t.user_text), lower(${q})) - ${SNIPPET_LEAD}) AS start
    ) w ON t.id IS NOT NULL`;
}

function viewerTier(row: ChatSearchRow) {
  if (row.viewerRelation !== "unrelated") return 0;
  return row.isMember ? 1 : 2;
}

export function toChatCandidates(rows: readonly ChatSearchRow[], query: string): SearchCandidate[] {
  return rows.map((row) => {
    const ownTitle = toSearchDisplayText(row.title);
    const title = ownTitle || toSearchDisplayText(row.latestMessageText).slice(0, TITLE_LIMIT);
    const titleScore = row.titleScore === null ? null : Number(row.titleScore);
    const turnScore = row.turnScore === null ? 0 : Number(row.turnScore) * MESSAGE_WEIGHT;
    const excerpt = row.turnId ? buildSearchExcerpt(row.snippet, query, {
      clippedStart: row.snippetClippedStart === true,
      clippedEnd: row.snippetClippedEnd === true,
    }) : null;
    const hit = row.turnId && row.sequence !== null && excerpt
      ? { turnId: row.turnId, sequence: row.sequence, excerpt: excerpt.text, highlights: excerpt.highlights }
      : null;
    const matchCount = Number(row.turnMatches) + (titleScore === null ? 0 : 1);
    const titleHighlights = titleScore === null ? [] : findSearchMatches(ownTitle, query);
    const base = `/spaces/${row.spaceId}/sessions/${row.sessionId}`;
    return {
      type: "chat",
      id: row.sessionId,
      spaceId: row.spaceId,
      sessionId: row.sessionId,
      title,
      ...(titleHighlights.length > 0 ? { titleHighlights } : {}),
      excerpt: null,
      hit,
      matchCount,
      spaceName: row.spaceName,
      spaceAvatarUrl: row.spaceAvatarUrl,
      ownerUserUuid: null,
      matchedField: (titleScore ?? 0) >= turnScore ? "title" : "userText",
      href: hit ? `${base}?turn=${hit.sequence}` : base,
      updatedAt: toIso(row.updatedAt),
      textScore: Math.min(1, Math.max(titleScore ?? 0, turnScore) + Math.min(0.05, (matchCount - 1) * 0.01)),
      typePriorityScore: 0.74,
      membershipPriorityScore: row.isMember ? 1 : 0,
      viewerTier: viewerTier(row),
      viewerRelation: row.viewerRelation,
    };
  });
}
