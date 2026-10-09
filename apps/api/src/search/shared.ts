import { sql, type SQL } from "drizzle-orm";
import type { SearchTextRange } from "@cohub/protocol";

export const SEARCH_TYPES = ["chat", "space", "label"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export type SearchMatchedField = "title" | "userText" | "name" | "description" | "labelName" | "labelItemContent";
export type SearchViewerRelation = "creator" | "participant" | "unrelated";

export type SearchCandidate = {
  type: SearchType;
  id: string;
  spaceId: string;
  sessionId: string | null;
  title: string;
  titleHighlights?: SearchTextRange[];
  excerpt: string | null;
  hit?: { turnId: string; sequence: number; excerpt: string; highlights: SearchTextRange[] } | null;
  matchCount?: number;
  spaceName: string | null;
  spaceAvatarUrl: string | null;
  ownerUserUuid: string | null;
  matchedField: SearchMatchedField;
  href: string;
  updatedAt: string | null;
  textScore: number;
  typePriorityScore: number;
  membershipPriorityScore: number;
  viewerTier: number;
  viewerRelation: SearchViewerRelation | null;
  labelRef?: string | null;
  labelName?: string | null;
  labelResourceType?: string | null;
  labelResourceRef?: string | null;
};

export type RankedSearchCandidate = SearchCandidate & {
  score: number;
  recencyScore: number;
  effectiveTier: number;
};

export function normalizeSearchQuery(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function hasInformativeQuery(value: string) {
  return /[\p{L}\p{N}]/u.test(value);
}

export function normalizeLabelRef(value: string | undefined) {
  return (value ?? "")
    .split("/")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("/");
}

export function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function containsSql(column: SQL, query: string) {
  return sql`${column} ILIKE '%' || ${escapeLikePattern(query)} || '%' ESCAPE '\\'`;
}

export function substringQualitySql(column: SQL, query: string) {
  return sql`CASE
    WHEN lower(${column}) = lower(${query}) THEN 1.00
    WHEN lower(${column}) LIKE lower(${escapeLikePattern(query)}) || '%' ESCAPE '\\' THEN 0.92
    ELSE 0.74
  END::double precision`;
}

export function visibleSpacesSql(viewerUuid: string, spaceId: string | null) {
  return sql`
    SELECT
      s.*,
      CASE
        WHEN s.user_uuid = ${viewerUuid} OR sm.user_id IS NOT NULL THEN 1.0::double precision
        ELSE 0.0::double precision
      END AS membership_priority_score,
      CASE
        WHEN s.user_uuid = ${viewerUuid} THEN 'owner'
        WHEN sm.user_id IS NOT NULL THEN 'member'
        ELSE 'public'
      END AS space_relation
    FROM v2.spaces s
    LEFT JOIN v2.space_members sm
      ON sm.space_id = s.id AND sm.user_id = ${viewerUuid}
    WHERE
      (${spaceId}::uuid IS NULL OR s.id = ${spaceId}::uuid)
      AND (
        s.user_uuid = ${viewerUuid}
        OR sm.user_id IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM v2.access_policies ap
          WHERE ap.resource_type = 'space'
            AND ap.resource_id = s.id
            AND (ap.signed_in_user_role IS NOT NULL OR ap.anonymous_user_role IS NOT NULL)
        )
      )`;
}

export function compactText(value: string | null | undefined, limit: number) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

export function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function recencyScore(updatedAt: string | null, now: number) {
  if (!updatedAt) return 0;
  const ageDays = Math.max(0, now - new Date(updatedAt).getTime()) / 86_400_000;
  return 1 / (1 + ageDays / 30);
}

export function rankSearchCandidates(
  candidates: readonly SearchCandidate[],
  options: { longQuery: boolean; limit: number; now?: number },
): RankedSearchCandidate[] {
  const now = options.now ?? Date.now();
  return candidates
    .map((candidate) => {
      const recency = recencyScore(candidate.updatedAt, now);
      return {
        ...candidate,
        recencyScore: recency,
        effectiveTier: options.longQuery && candidate.textScore >= 0.9 ? 0 : candidate.viewerTier,
        score:
          candidate.textScore * 0.68 +
          recency * 0.16 +
          candidate.typePriorityScore * 0.05 +
          candidate.membershipPriorityScore * 0.11,
      };
    })
    .sort(
      (a, b) =>
        a.effectiveTier - b.effectiveTier ||
        b.score - a.score ||
        b.membershipPriorityScore - a.membershipPriorityScore ||
        b.textScore - a.textScore ||
        b.typePriorityScore - a.typePriorityScore ||
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    )
    .slice(0, options.limit);
}
