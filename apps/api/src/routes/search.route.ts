import { sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { createLogger } from "@cohub/infra/logging";
import { isUuid } from "@cohub/protocol/identifiers";
import { db } from "../db/index.js";
import { normalizePublicAvatarUrl, useAuth } from "../lib/middleware.js";
import { asAccountIdentity, hasPermission } from "../permissions.js";
import { buildChatSearchQuery, toChatCandidates, type ChatSearchRow } from "../search/chats.js";
import { buildLabelSearchQuery, toLabelCandidates, type LabelSearchRow } from "../search/labels.js";
import {
  hasInformativeQuery,
  normalizeLabelRef,
  normalizeSearchQuery,
  rankSearchCandidates,
  SEARCH_TYPES,
  type RankedSearchCandidate,
  type SearchCandidate,
  type SearchType,
} from "../search/shared.js";
import { buildSpaceSearchQuery, toSpaceCandidates, type SpaceSearchRow } from "../search/spaces.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../user-profiles.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();
const MIN_QUERY_LENGTH = 2;
const MIN_MESSAGE_QUERY_LENGTH = 3;
const LONG_QUERY_LENGTH = 12;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

function clampLimit(value: string | undefined) {
  const parsed = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}

function parseTypes(values: string[]) {
  const types = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  const invalid = types.find((type) => !SEARCH_TYPES.includes(type as SearchType));
  if (invalid) return { error: `invalid search type: ${invalid}` } as const;
  return { types: new Set<SearchType>(types.length > 0 ? (types as SearchType[]) : SEARCH_TYPES) } as const;
}

async function execute<T>(query: SQL) {
  return [...(await db.execute(query))] as T[];
}

/** Space and label matching rely on the trigram `%` operator at this threshold. */
async function executeTrigram<T>(query: SQL) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL pg_trgm.similarity_threshold = 0.2`);
    return [...(await tx.execute(query))] as T[];
  });
}

async function ownerProfiles(candidates: readonly RankedSearchCandidate[], viewerUuid: string) {
  const owners = candidates.flatMap((candidate) => (candidate.type === "space" && candidate.ownerUserUuid ? [candidate.ownerUserUuid] : []));
  try {
    return await getProfilesByUuids(owners);
  } catch (error) {
    logger.warn("[search] profile enrichment failed", { userUuid: viewerUuid, ownerCount: new Set(owners).size, error });
    return new Map<string, ReturnType<typeof fallbackPublicUserProfile>>();
  }
}

function toResult(candidate: RankedSearchCandidate, profiles: Awaited<ReturnType<typeof ownerProfiles>>) {
  const { ownerUserUuid, spaceAvatarUrl, viewerTier: _viewerTier, ...result } = candidate;
  return {
    ...result,
    ownerProfile:
      candidate.type === "space" && ownerUserUuid
        ? (profiles.get(ownerUserUuid) ?? fallbackPublicUserProfile(ownerUserUuid))
        : null,
    spaceProfile: { avatarUrl: normalizePublicAvatarUrl(spaceAvatarUrl) },
    source: "remote" as const,
  };
}

router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const identity = asAccountIdentity(user);
  if (!identity) return c.json({ message: "forbidden" }, 403);

  const q = normalizeSearchQuery(c.req.query("q"));
  const limit = clampLimit(c.req.query("limit"));
  const labelRef = normalizeLabelRef(c.req.query("labelRef"));
  const parsedTypes = parseTypes([...(c.req.queries("type") ?? []), c.req.query("types") ?? ""]);
  if ("error" in parsedTypes) return c.json({ message: parsedTypes.error }, 400);
  const spaceId = c.req.query("spaceId")?.trim() || null;
  if (spaceId && !isUuid(spaceId)) return c.json({ message: "invalid spaceId" }, 400);

  const searchable = q.length >= MIN_QUERY_LENGTH && hasInformativeQuery(q);
  const [canListSessions, canListSpaces] = await Promise.all([
    hasPermission(user, "user.session.list", { spaceId: "" }),
    hasPermission(user, "user.space.list", { spaceId: "" }),
  ]);
  const includeChats = searchable && canListSessions && parsedTypes.types.has("chat");
  const includeSpaces = searchable && canListSpaces && parsedTypes.types.has("space");
  const includeLabels = labelRef !== "" && canListSpaces && parsedTypes.types.has("label");
  const viewerUuid = identity.uuid;

  const searches: Promise<SearchCandidate[]>[] = [];
  if (includeChats) {
    const query = buildChatSearchQuery({
      viewerUuid,
      query: q,
      spaceId,
      includeMessages: spaceId !== null || [...q].length >= MIN_MESSAGE_QUERY_LENGTH,
      limit,
    });
    searches.push(execute<ChatSearchRow>(query).then((rows) => toChatCandidates(rows, q)));
  }
  if (includeSpaces) {
    const query = buildSpaceSearchQuery({ viewerUuid, query: q, spaceId, limit });
    searches.push(executeTrigram<SpaceSearchRow>(query).then(toSpaceCandidates));
  }
  if (includeLabels) {
    const query = buildLabelSearchQuery({ viewerUuid, query: q, labelRef, spaceId, limit });
    searches.push(executeTrigram<LabelSearchRow>(query).then((rows) => toLabelCandidates(rows, q)));
  }

  const settled = await Promise.allSettled(searches);
  const failures = settled.filter((outcome) => outcome.status === "rejected");
  for (const failure of failures) {
    logger.warn("[search] search failed", { userUuid: viewerUuid, queryLength: q.length, error: failure.reason });
  }
  const ranked = rankSearchCandidates(
    settled.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value : [])),
    { longQuery: q.length >= LONG_QUERY_LENGTH, limit },
  );
  const profiles = await ownerProfiles(ranked, viewerUuid);
  return c.json({
    items: ranked.map((candidate) => toResult(candidate, profiles)),
    query: q,
    source: "remote",
    ...(failures.length > 0 ? { degraded: true } : {}),
  });
});

export default router;
