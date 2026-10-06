import { sql } from "drizzle-orm";
import { compactText, escapeLikePattern, toIso, visibleSpacesSql, type SearchCandidate } from "./shared.js";

const MAX_CANDIDATES = 150;
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export type LabelSearchInput = {
  viewerUuid: string;
  query: string;
  labelRef: string;
  spaceId: string | null;
  limit: number;
};

export type LabelSearchRow = {
  id: string;
  spaceId: string;
  sessionId: string | null;
  title: string | null;
  excerpt: string | null;
  spaceName: string | null;
  spaceAvatarUrl: string | null;
  updatedAt: Date | string | null;
  textScore: number;
  membershipPriorityScore: number;
  labelRef: string;
  labelName: string;
  labelResourceType: string;
  labelResourceRef: string;
};

export function buildLabelSearchQuery(input: LabelSearchInput) {
  const q = input.query;
  const escapedQ = escapeLikePattern(q);
  const refAsUuid = (resourceType: string) =>
    sql`CASE WHEN la.resource_type = ${resourceType} AND la.resource_ref ~* ${UUID_PATTERN} THEN la.resource_ref::uuid ELSE NULL::uuid END`;
  return sql`
    WITH visible_spaces AS MATERIALIZED (${visibleSpacesSql(input.viewerUuid, input.spaceId)}),
    label_matches AS (
      SELECT
        l.id,
        l.name,
        l.scope_id,
        sp.name AS space_name,
        sp.meta #>> '{publicProfile,avatarUrl}' AS space_avatar_url,
        sp.membership_priority_score,
        CASE WHEN parent.id IS NULL THEN l.name ELSE parent.name || '/' || l.name END AS label_ref
      FROM v2.labels l
      JOIN visible_spaces sp ON sp.id::text = l.scope_id
      LEFT JOIN v2.labels parent
        ON parent.id = l.parent_id AND parent.scope_type = l.scope_type AND parent.scope_id = l.scope_id
      WHERE
        l.scope_type = 'space'
        AND (
          lower(CASE WHEN parent.id IS NULL THEN l.name ELSE parent.name || '/' || l.name END) = lower(${input.labelRef})
          OR lower(l.name) = lower(${input.labelRef})
        )
    )
    SELECT
      la.id,
      lm.scope_id AS "spaceId",
      ${refAsUuid("session")} AS "sessionId",
      CASE
        WHEN la.resource_type = 'session' THEN coalesce(nullif(sess.title, ''), sess.latest_message_text, 'New chat')
        WHEN la.resource_type = 'checkpoint' THEN coalesce(nullif(cp.description, ''), left(cp.commit_hash, 12))
        WHEN la.resource_type = 'file' THEN coalesce(nullif(split_part(la.resource_ref, '/', array_length(string_to_array(la.resource_ref, '/'), 1)), ''), la.resource_ref)
        ELSE la.resource_ref
      END AS title,
      CASE
        WHEN la.resource_type = 'session' THEN left(sess.latest_message_text, 520)
        WHEN la.resource_type = 'checkpoint' THEN cp.commit_hash
        WHEN la.resource_type = 'file' THEN la.resource_ref
        ELSE NULL::text
      END AS excerpt,
      lm.space_name AS "spaceName",
      lm.space_avatar_url AS "spaceAvatarUrl",
      coalesce(sess.last_message_at, sess.updated_at, cp.created_at, la.updated_at, la.created_at) AS "updatedAt",
      CASE
        WHEN ${q} = '' THEN 1.00
        WHEN lower(coalesce(sess.title, '')) = lower(${q}) THEN 1.00
        WHEN lower(coalesce(sess.latest_message_text, '')) = lower(${q}) THEN 0.96
        WHEN lower(coalesce(cp.description, '')) = lower(${q}) THEN 0.94
        WHEN lower(la.resource_ref) = lower(${q}) THEN 0.92
        WHEN coalesce(sess.title, '') ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.78
        WHEN coalesce(sess.latest_message_text, '') ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.74
        WHEN coalesce(cp.description, '') ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.74
        WHEN la.resource_ref ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.72
        ELSE GREATEST(
          similarity(coalesce(sess.title, ''), ${q}) * 0.72,
          similarity(coalesce(sess.latest_message_text, ''), ${q}) * 0.66,
          similarity(coalesce(cp.description, ''), ${q}) * 0.66,
          similarity(la.resource_ref, ${q}) * 0.64
        )
      END AS "textScore",
      lm.membership_priority_score AS "membershipPriorityScore",
      lm.label_ref AS "labelRef",
      lm.name AS "labelName",
      la.resource_type AS "labelResourceType",
      la.resource_ref AS "labelResourceRef"
    FROM label_matches lm
    JOIN v2.label_assignments la
      ON la.label_id = lm.id AND la.scope_type = 'space' AND la.scope_id = lm.scope_id
    LEFT JOIN v2.space_sessions sess
      ON sess.id = ${refAsUuid("session")}
      AND sess.space_id = lm.scope_id::uuid
      -- Outside members, a session policy overrides the public Space policy.
      AND (
        lm.membership_priority_score >= 1
        OR coalesce(
          (SELECT ap.signed_in_user_role IS NOT NULL OR ap.anonymous_user_role IS NOT NULL
            FROM v2.access_policies ap
            WHERE ap.resource_type = 'session' AND ap.resource_id = sess.id),
          true
        )
      )
    LEFT JOIN v2.checkpoints cp
      ON cp.space_id = lm.scope_id::uuid AND cp.id = ${refAsUuid("checkpoint")}
    WHERE
      (
        (la.resource_type = 'session' AND sess.id IS NOT NULL)
        OR (la.resource_type = 'checkpoint' AND cp.id IS NOT NULL)
        OR la.resource_type = 'file'
      )
      AND (
        ${q} = ''
        OR sess.title ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
        OR sess.latest_message_text ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
        OR cp.description ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
        OR cp.commit_hash ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
        OR la.resource_ref ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
        OR sess.title % ${q}
        OR sess.latest_message_text % ${q}
        OR cp.description % ${q}
        OR la.resource_ref % ${q}
      )
    ORDER BY lm.membership_priority_score DESC, "textScore" DESC, la.id
    LIMIT ${Math.min(input.limit * 3, MAX_CANDIDATES)}`;
}

function labelHref(row: LabelSearchRow) {
  if (row.labelResourceType === "session") return `/spaces/${row.spaceId}/sessions/${row.labelResourceRef}`;
  if (row.labelResourceType === "checkpoint") return `/spaces/${row.spaceId}/checkpoints/${row.labelResourceRef}`;
  if (row.labelResourceType === "file") {
    return `/spaces/${row.spaceId}/files/${row.labelResourceRef.split("/").map(encodeURIComponent).join("/")}`;
  }
  return `/spaces/${row.spaceId}`;
}

export function toLabelCandidates(rows: readonly LabelSearchRow[], query: string): SearchCandidate[] {
  return rows.map((row) => {
    const membershipPriorityScore = Number(row.membershipPriorityScore);
    return {
      type: "label",
      id: row.id,
      spaceId: row.spaceId,
      sessionId: row.sessionId,
      title: compactText(row.title, 220) ?? row.labelResourceRef,
      excerpt: compactText(row.excerpt, 260),
      spaceName: row.spaceName,
      spaceAvatarUrl: row.spaceAvatarUrl,
      ownerUserUuid: null,
      matchedField: query ? "labelItemContent" : "labelName",
      href: labelHref(row),
      updatedAt: toIso(row.updatedAt),
      textScore: Number(row.textScore),
      typePriorityScore: 0.72,
      membershipPriorityScore,
      viewerTier: membershipPriorityScore >= 1 ? 1 : 2,
      viewerRelation: null,
      labelRef: row.labelRef,
      labelName: row.labelName,
      labelResourceType: row.labelResourceType,
      labelResourceRef: row.labelResourceRef,
    };
  });
}
