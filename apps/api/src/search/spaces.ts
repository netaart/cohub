import { sql } from "drizzle-orm";
import { compactText, escapeLikePattern, toIso, visibleSpacesSql, type SearchCandidate } from "./shared.js";

const MAX_CANDIDATES = 150;

export type SpaceSearchInput = {
  viewerUuid: string;
  query: string;
  spaceId: string | null;
  limit: number;
};

export type SpaceSearchRow = {
  id: string;
  name: string;
  description: string | null;
  ownerUserUuid: string;
  avatarUrl: string | null;
  updatedAt: Date | string | null;
  nameScore: number;
  descriptionScore: number;
  membershipPriorityScore: number;
  spaceRelation: "owner" | "member" | "public";
};

export function buildSpaceSearchQuery(input: SpaceSearchInput) {
  const q = input.query;
  const escapedQ = escapeLikePattern(q);
  return sql`
    WITH visible_spaces AS MATERIALIZED (${visibleSpacesSql(input.viewerUuid, input.spaceId)})
    SELECT
      s.id,
      s.name,
      s.description,
      s.user_uuid AS "ownerUserUuid",
      s.meta #>> '{publicProfile,avatarUrl}' AS "avatarUrl",
      coalesce(s.last_activity_at, s.updated_at, s.created_at) AS "updatedAt",
      scores.name_score AS "nameScore",
      scores.description_score AS "descriptionScore",
      s.membership_priority_score AS "membershipPriorityScore",
      s.space_relation AS "spaceRelation"
    FROM visible_spaces s
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN lower(s.name) = lower(${q}) THEN 1.00
          WHEN lower(s.name) LIKE lower(${escapedQ}) || '%' ESCAPE '\\' THEN 0.92
          WHEN s.name ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.74
          ELSE similarity(s.name, ${q}) * 0.70
        END * 0.90 AS name_score,
        CASE
          WHEN lower(coalesce(s.description, '')) = lower(${q}) THEN 1.00
          WHEN lower(coalesce(s.description, '')) LIKE lower(${escapedQ}) || '%' ESCAPE '\\' THEN 0.88
          WHEN coalesce(s.description, '') ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.68
          ELSE similarity(coalesce(s.description, ''), ${q}) * 0.58
        END * 0.68 AS description_score
    ) scores
    WHERE
      s.name ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
      OR s.description ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
      OR s.name % ${q}
      OR s.description % ${q}
    ORDER BY
      CASE s.space_relation WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END,
      greatest(scores.name_score, scores.description_score) DESC,
      s.id
    LIMIT ${Math.min(input.limit * 3, MAX_CANDIDATES)}`;
}

const SPACE_TIER = { owner: 0, member: 1, public: 2 } as const;

export function toSpaceCandidates(rows: readonly SpaceSearchRow[]): SearchCandidate[] {
  return rows.map((row) => {
    const nameScore = Number(row.nameScore);
    const descriptionScore = Number(row.descriptionScore);
    return {
      type: "space",
      id: row.id,
      spaceId: row.id,
      sessionId: null,
      title: row.name,
      excerpt: compactText(row.description, 220),
      spaceName: row.name,
      spaceAvatarUrl: row.avatarUrl,
      ownerUserUuid: row.ownerUserUuid,
      matchedField: nameScore >= descriptionScore ? "name" : "description",
      href: `/spaces/${row.id}`,
      updatedAt: toIso(row.updatedAt),
      textScore: Math.max(nameScore, descriptionScore),
      typePriorityScore: 1,
      membershipPriorityScore: Number(row.membershipPriorityScore),
      viewerTier: SPACE_TIER[row.spaceRelation],
      viewerRelation: null,
    };
  });
}
