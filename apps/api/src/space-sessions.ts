import { createLogger } from "@cohub/infra/logging";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Usage } from "@cohub/protocol/core";
import type { PersistMessageInput, RegisterSessionInput, SessionTurnRecord, UpdateSessionInfoInput } from "@cohub/protocol/model";
import type { ModelThinkingLevel } from "@cohub/protocol";
import { getOrCreateRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { SPACE_ENV_REDIS_KEY } from "@cohub/protocol/sandbox";
import { isSandboxUsableStatus } from "@cohub/sandbox-controller";
import { sanitizeContentBlocksForPostgresJson, sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import { assignSessionParticipantSystemLabels } from "@cohub/core/labels/session-user";
import { SESSION_SOURCE_KEYS, sessionSourceRawValues } from "@cohub/core/labels/session-source";
import {
  claimSessionFallbackTitle,
  deriveSessionFallbackTitle,
  initializeSessionParticipantsMeta,
  normalizeSessionTitle,
  readSessionParticipantUserUuids,
  readSessionTitleSource,
  resolveMessageTurnId,
  setSessionTitleMeta,
  shouldGenerateSessionTitle,
} from "@cohub/core/sessions";
import { db } from "./db/index.js";
import {
  sessionMessages,
  sessionTurnSegments,
  sessionTurns,
  spaceSessions,
  spaces,
} from "@cohub/db";
import { getSpaceSandboxBySpaceId, updateSpaceSandbox } from "./space-sandboxes.js";
import { buildSessionOutputsForPersistedMessage, dispatchSessionOutputs, dispatchTurnFinalized, dispatchTurnUpdated } from "./session-output.js";
import { dispatchLabelAssignmentsUpdated, dispatchSessionCreated, dispatchSessionUpdated, dispatchTurnCreated } from "./realtime-events.js";
import { finalizeSessionTurnFromMessage, getSessionTurnById, hydrateTurnAuthorProfiles } from "./session-turns.js";
import { enqueueAgentSessionForkJob } from "./agent-turn-queue.js";
import { requestAgentTurnAbort } from "./agent-turn-abort.js";
import { countToolCallsInContent, deriveMessagePreviewText } from "./session-content.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "./user-profiles.js";
// space public profile is inlined in attachSessionSpaceSummaries to avoid route-layer coupling
import { enqueueSessionMessagePostprocess } from "./session-message-postprocess-queue.js";
import { enqueueSessionTitleGeneration } from "./session-title-queue.js";
import { touchSpaceActivity } from "./space-activity.js";
import { pickActiveTurns } from "./session-active-turns.js";
import {
  decodeSessionListCursor,
  isOtherSessionSource,
  mergeUserSessionListBranches,
  resolveSessionListLimit,
  paginateSessionRows,
  type SessionListCursor,
  type SessionSourceFilter,
} from "./session-list.js";

export {
  encodeSessionListCursor,
  InvalidSessionListCursorError,
  InvalidSessionSourceFilterError,
  MAX_SESSION_LIST_LIMIT,
  mergeUserSessionListBranches,
  parseSessionSourceKeys,
  sessionSourceKeyOf,
  type SessionSourceFilter,
} from "./session-list.js";


const logger = createLogger({ serviceName: "cohub-api" });
export class SandboxNotReadyError extends Error {
  constructor(message = "space sandbox is not ready") {
    super(message);
    this.name = "SandboxNotReadyError";
  }
}

export class SpaceEnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceEnvValidationError";
  }
}

const normalizeRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const THINKING_LEVEL_SET = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function extractThinkingLevel(meta: unknown): ModelThinkingLevel | null {
  const record = normalizeRecord(meta);
  if (!record) return null;
  const level = record.effectiveThinkingLevel;
  return typeof level === "string" && THINKING_LEVEL_SET.has(level) ? level as ModelThinkingLevel : null;
}

const finiteNumberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const finiteNumberOrZero = (value: unknown): number => finiteNumberOrUndefined(value) ?? 0;

const compactUndefined = <T extends Record<string, unknown>>(value: T): Partial<T> => Object.fromEntries(
  Object.entries(value).filter(([, nestedValue]) => nestedValue !== undefined),
) as Partial<T>;

const normalizeUsage = (usage: PersistMessageInput["message"]["usage"]): Usage | null => {
  if (!usage || typeof usage !== "object") return null;

  const cost = usage.cost && typeof usage.cost === "object"
    ? compactUndefined({
        input: finiteNumberOrUndefined(usage.cost.input),
        output: finiteNumberOrUndefined(usage.cost.output),
        cacheRead: finiteNumberOrUndefined(usage.cost.cacheRead),
        cacheWrite: finiteNumberOrUndefined(usage.cost.cacheWrite),
        total: finiteNumberOrUndefined(usage.cost.total),
      })
    : null;
  if (cost && cost.total === undefined) {
    cost.total = finiteNumberOrZero(cost.input)
      + finiteNumberOrZero(cost.output)
      + finiteNumberOrZero(cost.cacheRead)
      + finiteNumberOrZero(cost.cacheWrite);
  }

  return compactUndefined({
    input: finiteNumberOrUndefined(usage.input),
    output: finiteNumberOrUndefined(usage.output),
    cacheRead: finiteNumberOrUndefined(usage.cacheRead),
    cacheWrite: finiteNumberOrUndefined(usage.cacheWrite),
    totalTokens: finiteNumberOrUndefined(usage.totalTokens),
    cost: cost && Object.keys(cost).length > 0 ? cost : null,
  }) as Usage;
};

const toDateOrNull = (value: string | Date | null | undefined) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const durationBetweenMs = (startedAt: Date | null, completedAt: Date | null) => {
  if (!startedAt || !completedAt) return null;
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
};

const normalizeDurationMs = (value: unknown, fallback: number | null) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;

export const normalizeSpaceEnv = (input: unknown): Array<{ name: string; value: string }> => {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is { name?: unknown; value?: unknown } => Boolean(item) && typeof item === "object")
    .map((item) => ({ name: String(item.name ?? "").trim(), value: String(item.value ?? "") }))
    .filter((item) => item.name.length > 0);
};

export const validateSpaceEnv = (envs: Array<{ name: string; value: string }>) => {
  if (envs.length > 50) throw new SpaceEnvValidationError("extraEnv cannot exceed 50 entries");
  const seen = new Set<string>();
  for (const env of envs) {
    if (env.name.length > 128) throw new SpaceEnvValidationError("env name too long");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.name)) {
      throw new SpaceEnvValidationError("env name must start with a letter or underscore and contain only letters, numbers, and underscores");
    }
    if (env.value.length > 4000) throw new SpaceEnvValidationError("env value too long");
    if (seen.has(env.name)) throw new SpaceEnvValidationError(`duplicate env name: ${env.name}`);
    seen.add(env.name);
  }
};

export const setSpaceEnv = async (spaceId: string, envs: Array<{ name: string; value: string }>) => {
  const key = SPACE_ENV_REDIS_KEY(spaceId);
  const { redisCommandClient } = await import("./redis.js");
  try {
    await redisCommandClient.set(key, JSON.stringify(envs));
  } catch (err) {
    // DB is already updated; Redis write failure means agent may serve stale env
    // until the next successful env update or refresh after Redis recovers
    logger.warn(`[SpaceEnv] Failed to write env cache for ${spaceId}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export const getSpaceById = async (spaceId: string) => {
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  return space ?? null;
};

export const getSpaceSessionById = async (spaceSessionId: string) => {
  const [session] = await db.select().from(spaceSessions).where(eq(spaceSessions.id, spaceSessionId)).limit(1);
  return session ?? null;
};

export const getSessionMessageById = async (spaceSessionId: string, messageId: string) => {
  const [message] = await db.select().from(sessionMessages).where(and(eq(sessionMessages.sessionId, spaceSessionId), eq(sessionMessages.id, messageId))).limit(1);
  return message ?? null;
};

export const ensureRootSessionTurnSegment = async (sessionId: string) => {
  await db.insert(sessionTurnSegments).values({
    sessionId,
    ordinal: 1,
    sourceSessionId: sessionId,
    fromSequence: 1,
    toSequence: null,
  }).onConflictDoNothing({
    target: [sessionTurnSegments.sessionId, sessionTurnSegments.ordinal],
  });
};

const normalizeRequiredUserUuid = (userUuid: string | null | undefined) => {
  const normalized = userUuid?.trim();
  if (!normalized) throw new Error("userUuid is required");
  return normalized;
};

async function assignSessionUserLabelsAndDispatch(input: { spaceId: string; sessionId: string; userUuids: string[] }) {
  const affectedLabelIds = await assignSessionParticipantSystemLabels({
    db,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    userUuids: input.userUuids,
  });
  await dispatchLabelAssignmentsUpdated({
    spaceId: input.spaceId,
    resourceType: "session",
    resourceRef: input.sessionId,
    sessionId: input.sessionId,
    affectedLabelIds,
  });
}

export const createInitialSpaceSession = async (input: RegisterSessionInput) => {
  const userUuid = normalizeRequiredUserUuid(input.userUuid);
  const title = normalizeSessionTitle(input.title);
  const participantMeta = initializeSessionParticipantsMeta(input.meta, userUuid);
  const [session] = await db.insert(spaceSessions).values({
    id: input.sessionId,
    spaceId: input.spaceId,
    userUuid,
    title,
    source: input.source ?? null,
    status: "active",
    externalSessionId: input.externalSessionId ?? null,
    meta: sanitizePostgresJsonValue(title ? setSessionTitleMeta(participantMeta, { source: "user" }) : participantMeta),
    lastMessageAt: new Date(),
    lastMessageId: null,
  }).returning();
  if (!session) throw new Error("Failed to create initial space session");
  await ensureRootSessionTurnSegment(input.sessionId);
  await dispatchSessionCreated(session).catch((error) => {
    logger.warn("[Realtime] failed to dispatch session.created", error);
  });
  await assignSessionUserLabelsAndDispatch({ spaceId: input.spaceId, sessionId: session.id, userUuids: [userUuid] }).catch((error) => {
    logger.warn("[SessionUserLabel] failed to assign participant label", error);
  });
  return session;
};

export const registerSpaceSession = async (input: RegisterSessionInput) => {
  const space = await getSpaceById(input.spaceId);
  if (!space) throw new Error("Space not found");

  const userUuid = normalizeRequiredUserUuid(input.userUuid);
  const title = normalizeSessionTitle(input.title);
  const participantMeta = initializeSessionParticipantsMeta(input.meta, userUuid);

  try {
    const [session] = await db.insert(spaceSessions).values({
      id: input.sessionId,
      spaceId: input.spaceId,
      userUuid,
      title,
      source: input.source ?? null,
      status: "active",
      externalSessionId: input.externalSessionId ?? null,
      meta: sanitizePostgresJsonValue(title ? setSessionTitleMeta(participantMeta, { source: "user" }) : participantMeta),
      lastMessageAt: new Date(),
      lastMessageId: null,
    }).returning();
    if (!session) throw new Error("Failed to register space session");
    await ensureRootSessionTurnSegment(input.sessionId);
    await dispatchSessionCreated(session).catch((error) => {
      logger.warn("[Realtime] failed to dispatch session.created", error);
    });
    await assignSessionUserLabelsAndDispatch({ spaceId: input.spaceId, sessionId: session.id, userUuids: [userUuid] }).catch((error) => {
      logger.warn("[SessionUserLabel] failed to assign participant label", error);
    });
    return session;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("duplicate key") || message.includes("already exists") || message.includes("unique")) {
      const [existing] = await db.select().from(spaceSessions).where(eq(spaceSessions.id, input.sessionId)).limit(1);
      if (existing) {
        await ensureRootSessionTurnSegment(existing.id);
        return existing;
      }
    }
    throw error;
  }
};

export const hydrateSessionParticipantProfiles = async <T extends typeof spaceSessions.$inferSelect>(sessions: T[]) => {
  const allUserUuids = new Set<string>();
  for (const session of sessions) {
    if (session.userUuid?.trim()) allUserUuids.add(session.userUuid.trim());
    for (const userUuid of readSessionParticipantUserUuids(session.meta)) allUserUuids.add(userUuid);
  }

  const profiles = await getProfilesByUuids([...allUserUuids]);
  return sessions.map((session) => {
    const participantUserUuids = readSessionParticipantUserUuids(session.meta);
    const userUuid = session.userUuid?.trim() || null;
    return {
      ...session,
      userUuid,
      userProfile: userUuid ? profiles.get(userUuid) ?? fallbackPublicUserProfile(userUuid) : null,
      participantUserUuids,
      participantProfiles: participantUserUuids.map((uuid) => profiles.get(uuid) ?? fallbackPublicUserProfile(uuid)),
    };
  });
};

/**
 * JSONB membership for meta.participants.userUuids.
 * Keep the expression free of coalesce() so it can use the GIN index on
 * (meta -> 'participants' -> 'userUuids'). Null path => no match.
 */
const userSessionParticipantCondition = (userUuid: string) =>
  sql`(${spaceSessions.meta} -> 'participants' -> 'userUuids') ? ${userUuid}`;

/** Matches `ORDER BY lastMessageAt DESC NULLS LAST, id DESC`. */
const sessionListActivityCursorCondition = (
  cursor: SessionListCursor | null,
) => {
  if (!cursor) return undefined;
  // NULLS LAST: after any non-null activity, continue with remaining null rows.
  if (cursor.date === null) {
    return and(
      isNull(spaceSessions.lastMessageAt),
      lt(spaceSessions.id, cursor.id),
    );
  }
  return or(
    lt(spaceSessions.lastMessageAt, cursor.date),
    isNull(spaceSessions.lastMessageAt),
    and(
      eq(spaceSessions.lastMessageAt, cursor.date),
      lt(spaceSessions.id, cursor.id),
    ),
  );
};

const sessionListOrderBy = [
  sql`${spaceSessions.lastMessageAt} desc nulls last`,
  desc(spaceSessions.id),
] as const;

const ACTIVE_TURN_STATUSES = ["queued", "running", "abort_requested"] as const;

export async function attachActiveTurns<T extends { id: string }>(sessions: T[]) {
  if (sessions.length === 0) return pickActiveTurns(sessions, []);

  const rows = await db
    .select({
      sessionId: sessionTurns.sessionId,
      id: sessionTurns.id,
      status: sessionTurns.status,
      provider: sessionTurns.provider,
      model: sessionTurns.model,
      startedAt: sessionTurns.startedAt,
      meta: sessionTurns.meta,
    })
    .from(sessionTurns)
    .where(and(
      inArray(sessionTurns.sessionId, sessions.map((session) => session.id)),
      inArray(sessionTurns.status, [...ACTIVE_TURN_STATUSES]),
    ))
    .orderBy(asc(sessionTurns.sessionId), desc(sessionTurns.sequence));

  return pickActiveTurns(sessions, rows);
}

export const listSpaceSessions = async (
  spaceId: string,
  options?: { limit?: number; cursor?: string | null },
) => {
  const limit = resolveSessionListLimit(options?.limit);
  const cursor = decodeSessionListCursor(options?.cursor);
  const activityCursor = sessionListActivityCursorCondition(cursor);

  const rows = await db.select().from(spaceSessions).where(
    activityCursor
      ? and(eq(spaceSessions.spaceId, spaceId), activityCursor)
      : eq(spaceSessions.spaceId, spaceId),
  ).orderBy(...sessionListOrderBy).limit(limit + 1);

  const page = paginateSessionRows(rows, limit);
  return {
    ...page,
    sessions: await attachActiveTurns(page.sessions),
  };
};

export type UserSessionSpaceSummary = {
  id: string;
  name: string;
  slug: string | null;
  publicProfile: { avatarUrl: string | null };
};

export const attachSessionSpaceSummaries = async <T extends { spaceId: string }>(
  sessions: T[],
): Promise<Array<T & { space: UserSessionSpaceSummary | null }>> => {
  if (sessions.length === 0) return [];
  const spaceIds = [...new Set(sessions.map((session) => session.spaceId).filter(Boolean))];
  if (spaceIds.length === 0) {
    return sessions.map((session) => ({ ...session, space: null }));
  }

  const spaceRows = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      slug: spaces.slug,
      meta: spaces.meta,
    })
    .from(spaces)
    .where(inArray(spaces.id, spaceIds));

  const spaceById = new Map(
    spaceRows.map((space) => {
      const meta = space.meta && typeof space.meta === "object" && !Array.isArray(space.meta)
        ? space.meta as Record<string, unknown>
        : {};
      const profile = meta.publicProfile && typeof meta.publicProfile === "object" && !Array.isArray(meta.publicProfile)
        ? meta.publicProfile as Record<string, unknown>
        : {};
      const avatarUrl = typeof profile.avatarUrl === "string" && profile.avatarUrl.trim()
        ? profile.avatarUrl.trim()
        : null;
      return [
        space.id,
        {
          id: space.id,
          name: space.name,
          slug: space.slug ?? null,
          publicProfile: { avatarUrl },
        } satisfies UserSessionSpaceSummary,
      ] as const;
    }),
  );

  return sessions.map((session) => ({
    ...session,
    space: spaceById.get(session.spaceId) ?? null,
  }));
};

const sessionSourceRawValuesFor = (key: string): string[] =>
  key === "web" ? ["web", "web_app"] : [...sessionSourceRawValues(key)];

/**
 * SQL predicate for a source-kind filter. `web` also matches a null source,
 * which is how legacy web rows were stored; `other` matches anything that does
 * not resolve to a known kind, so the picker never hides rows.
 */
const sessionListSourceCondition = (source: SessionSourceFilter | null) => {
  if (!source || source.keys.length === 0) return undefined;
  const knownRawValues = SESSION_SOURCE_KEYS.flatMap((key) =>
    key === "web" ? ["web", "web_app"] : sessionSourceRawValuesFor(key),
  );
  const clauses = source.keys.map((key) => {
    if (isOtherSessionSource(key)) {
      return and(
        isNotNull(spaceSessions.source),
        notInArray(spaceSessions.source, knownRawValues),
      );
    }
    const values = key === "web" ? ["web", "web_app"] : sessionSourceRawValuesFor(key);
    return key === "web"
      ? or(isNull(spaceSessions.source), inArray(spaceSessions.source, values))
      : inArray(spaceSessions.source, values);
  });
  return clauses.length === 1 ? clauses[0] : or(...clauses);
};

/**
 * List sessions created by or participated in by a user, across spaces.
 *
 * Split into two index-friendly branches (creator / participant-only) so the
 * planner can use user_uuid and the participants GIN index independently,
 * then merge in activity order. Participant branch excludes creator rows to
 * avoid duplicates before merge.
 */
export const listUserSessions = async (
  userUuid: string,
  options?: { limit?: number; cursor?: string | null; source?: SessionSourceFilter | null },
) => {
  const limit = resolveSessionListLimit(options?.limit);
  const cursor = decodeSessionListCursor(options?.cursor);
  const activityCursor = sessionListActivityCursorCondition(cursor);
  const sourceCondition = sessionListSourceCondition(options?.source ?? null);
  const branchLimit = limit + 1;

  const creatorWhere = and(eq(spaceSessions.userUuid, userUuid), activityCursor, sourceCondition);

  const participantWhere = and(
    userSessionParticipantCondition(userUuid),
    sql`${spaceSessions.userUuid} is distinct from ${userUuid}`,
    activityCursor,
    sourceCondition,
  );

  const [creatorRows, participantRows] = await Promise.all([
    db.select().from(spaceSessions).where(creatorWhere).orderBy(...sessionListOrderBy).limit(branchLimit),
    db.select().from(spaceSessions).where(participantWhere).orderBy(...sessionListOrderBy).limit(branchLimit),
  ]);

  const page = mergeUserSessionListBranches([creatorRows, participantRows], limit);
  return {
    ...page,
    sessions: await attachActiveTurns(page.sessions),
  };
};


const getNextSessionSequence = async (sessionId: string) => {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${sessionMessages.sequence}), 0)::int` }).from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
  return (row?.max ?? 0) + 1;
};

const updateSessionAfterAppend = async (session: Pick<typeof spaceSessions.$inferSelect, "id" | "spaceId">, message: typeof sessionMessages.$inferSelect, titleChanged = false) => {
  const activityAt = message.createdAt ?? new Date();
  await db.update(spaceSessions).set({
    lastMessageId: message.id,
    latestMessageText: message.text,
    lastMessageAt: activityAt,
    updatedAt: new Date(),
  }).where(eq(spaceSessions.id, session.id));
  await touchSpaceActivity(session.spaceId, activityAt).catch((error) => {
    logger.warn("[SpaceActivity] failed to touch after message append", error);
  });
  const refreshed = await getSpaceSessionById(session.id);
  if (refreshed) {
    await dispatchSessionUpdated({
      session: refreshed,
      changed: [
        "lastMessageId",
        "latestMessageText",
        "lastMessageAt",
        "updatedAt",
        ...(titleChanged ? ["title"] : []),
      ],
    }).catch((error) => {
      logger.warn("[Realtime] failed to dispatch session.updated after message append", error);
    });
  }
};

export const persistMessageNode = async (input: PersistMessageInput & { message: PersistMessageInput["message"] & { id?: string } }) => {
  const [existing] = await db.select().from(sessionMessages).where(and(eq(sessionMessages.sessionId, input.sessionId), eq(sessionMessages.idempotencyKey, input.idempotencyKey))).limit(1);
  if (existing) {
    if (existing.role === "assistant") {
      await enqueueSessionMessagePostprocess({
        sessionId: input.sessionId,
        messageId: existing.id,
      });
    } else if (existing.role === "user") {
      try {
        const [session] = await db.select({ meta: spaceSessions.meta })
          .from(spaceSessions)
          .where(eq(spaceSessions.id, input.sessionId))
          .limit(1);
        if (
          readSessionTitleSource(session?.meta) === "fallback"
          && shouldGenerateSessionTitle({ content: existing.content })
        ) {
          await enqueueSessionTitleGeneration({
            sessionId: input.sessionId,
            messageId: existing.id,
            userId: input.userId ?? null,
          });
        }
      } catch (error) {
        logger.warn("[SessionTitle] failed to re-enqueue title generation", error);
      }
    }
    return existing;
  }

  const session = await getSpaceSessionById(input.sessionId);
  if (!session || session.spaceId !== input.spaceId) throw new Error("Space session not found");

  const messageMeta = normalizeRecord(input.message.meta);
  const rawMessageTurnId = messageMeta?.turnId;
  const messageTurnId = resolveMessageTurnId(messageMeta);
  if (rawMessageTurnId != null && !messageTurnId) throw new Error("Invalid message turn id");
  if (messageTurnId) {
    const [turn] = await db.select({ id: sessionTurns.id }).from(sessionTurns).where(and(
      eq(sessionTurns.id, messageTurnId),
      eq(sessionTurns.sessionId, input.sessionId),
    )).limit(1);
    if (!turn) throw new Error("Message turn not found in session");
  }

  if (input.previousMessageId) {
    const [previous] = await db.select().from(sessionMessages).where(and(eq(sessionMessages.id, input.previousMessageId), eq(sessionMessages.sessionId, input.sessionId))).limit(1);
    if (!previous) throw new Error("Previous message not found");
  }

  const sequence = await getNextSessionSequence(input.sessionId);
  const content = sanitizeContentBlocksForPostgresJson(input.message.content);
  const text = deriveMessagePreviewText({ content }) || null;
  const messageRole = input.message.role ?? "assistant";
  const _shouldDispatchToProvider = messageRole === "assistant";
  const normalizedUsage = normalizeUsage(input.message.usage);

  const isAborted = input.message.stopReason === "aborted";
  const hasError = input.message.errorMessage || input.message.stopReason === "error";
  const isUnsuccessful = hasError || isAborted;
  if (messageRole === "assistant" && content.length === 0 && !text?.trim() && !isUnsuccessful) {
    throw new Error("Refusing to persist empty assistant message");
  }


  let anchorUserMessageId = input.anchorUserMessageId?.trim() || null;
  const userId = input.userId ?? null;
  const toolUseCount = countToolCallsInContent(content);
  const requestedMessageKind = (input.message.meta as Record<string, unknown> | null | undefined)?.messageKind;
  const isDirectShellCommandResult = requestedMessageKind === "shell_command_result";
  const isGenerationRequest = messageRole === "user" && requestedMessageKind === "generation_request";
  const isGenerationResult = requestedMessageKind === "generation_result";
  const messageKind = messageRole !== "assistant" ? isGenerationRequest ? "generation_request" : messageRole : isUnsuccessful ? "assistant_error" : isGenerationResult ? "generation_result" : isDirectShellCommandResult ? "assistant_final" : (toolUseCount > 0 || input.message.stopReason === "tool_use") ? "assistant_intermediate" : "assistant_final";
  const displayErrorMessage = isAborted ? null : input.message.errorMessage ?? null;
  const completedAt = toDateOrNull(input.message.completedAt) ?? new Date();
  const startedAt = toDateOrNull(input.message.startedAt) ?? completedAt;
  const durationMs = normalizeDurationMs(input.message.durationMs, durationBetweenMs(startedAt, completedAt));

  const [messageNode] = await db.insert(sessionMessages).values({
    id: input.message.id?.trim() || undefined,
    sessionId: input.sessionId,
    turnId: messageTurnId,
    role: messageRole,
    content,
    text,
    meta: sanitizePostgresJsonValue({
      ...((input.message.meta as Record<string, unknown> | null) ?? {}),
      ...(rawMessageTurnId != null ? { turnId: messageTurnId } : {}),
      messageKind,
      anchorUserMessageId,
      actorUserId: userId,
      providerResponseId: ((input.message.meta as Record<string, unknown> | null)?.responseId as string | undefined) ?? null,
    }),
    idempotencyKey: input.idempotencyKey,
    sequence,
    provider: input.message.provider ?? null,
    model: input.message.model ?? null,
    stopReason: input.message.stopReason ?? null,
    errorMessage: displayErrorMessage ? sanitizePostgresJsonValue(displayErrorMessage) : displayErrorMessage,
    usage: normalizedUsage,
    startedAt,
    completedAt,
    durationMs,
  }).returning();
  if (!messageNode) throw new Error("Failed to persist message");

  let titleChanged = false;
  if (messageRole === "user") {
    try {
      const fallbackTitle = deriveSessionFallbackTitle({
        content,
        text,
        generationRequest: isGenerationRequest,
      });
      if (fallbackTitle) {
        titleChanged = await claimSessionFallbackTitle(db, { sessionId: input.sessionId, title: fallbackTitle });
        if (titleChanged && shouldGenerateSessionTitle({ content, generationRequest: isGenerationRequest })) {
          await enqueueSessionTitleGeneration({
            sessionId: input.sessionId,
            messageId: messageNode.id,
            userId,
          });
        }
      }
    } catch (error) {
      logger.warn("[SessionTitle] failed to prepare title generation", error);
    }
  }

  await updateSessionAfterAppend(session, messageNode, titleChanged);

  if (messageRole === "user") {
    const turnId = typeof (input.message.meta as Record<string, unknown> | null | undefined)?.turnId === "string"
      ? ((input.message.meta as Record<string, unknown>).turnId as string)
      : null;
    if (turnId) {
      const [turnRow] = await db.select().from(sessionTurns).where(and(eq(sessionTurns.id, turnId), eq(sessionTurns.sessionId, input.sessionId))).limit(1);
      if (turnRow) {
        const turnRecord: SessionTurnRecord = {
          id: turnRow.id,
          sessionId: turnRow.sessionId,
          userUuid: turnRow.userUuid ?? null,
          sequence: turnRow.sequence,
          executionKind: turnRow.executionKind,
          status: turnRow.status as SessionTurnRecord["status"],
          intent: turnRow.intent as SessionTurnRecord["intent"],
          userContent: turnRow.userContent,
          userText: turnRow.userText ?? null,
          assistantContent: turnRow.assistantContent ?? null,
          assistantText: turnRow.assistantText ?? null,
          provider: turnRow.provider ?? null,
          model: turnRow.model ?? null,
          stopReason: turnRow.stopReason ?? null,
          errorMessage: turnRow.errorMessage ?? null,
          finalUsage: turnRow.finalUsage ?? null,
          totalUsage: turnRow.totalUsage ?? null,
          summary: turnRow.summary ?? null,
          intermediateIndex: turnRow.intermediateIndex ?? null,
          intermediateSummary: turnRow.intermediateSummary ?? null,
          meta: normalizeRecord(turnRow.meta),
          thinkingLevel: extractThinkingLevel(turnRow.meta),
          startedAt: turnRow.startedAt instanceof Date ? turnRow.startedAt.toISOString() : null,
          completedAt: turnRow.completedAt instanceof Date ? turnRow.completedAt.toISOString() : null,
          durationMs: turnRow.durationMs ?? null,
          createdAt: turnRow.createdAt instanceof Date ? turnRow.createdAt.toISOString() : new Date().toISOString(),
          updatedAt: turnRow.updatedAt instanceof Date ? turnRow.updatedAt.toISOString() : new Date().toISOString(),
        };
        const [turn = turnRecord] = await hydrateTurnAuthorProfiles([turnRecord]);
        await dispatchTurnCreated({
          spaceId: session.spaceId,
          sessionId: input.sessionId,
          turn,
        }).catch((error) => {
          logger.warn("[Realtime] failed to dispatch session.turn.created", error);
        });
      }
    }
  }

  if (messageRole === "assistant") {
    const turnId = typeof (input.message.meta as Record<string, unknown> | null | undefined)?.turnId === "string"
      ? ((input.message.meta as Record<string, unknown>).turnId as string)
      : null;
    if (turnId && (messageKind === "assistant_final" || messageKind === "assistant_error")) {
      const messageMeta = normalizeRecord(input.message.meta);
      const agentMeta = normalizeRecord(messageMeta?.agent);
      const agentSessionEntryId = typeof messageMeta?.agentSessionEntryId === "string"
        ? messageMeta.agentSessionEntryId
        : typeof agentMeta?.leafEntryId === "string"
          ? agentMeta.leafEntryId
          : null;
      const finalizedTurn = await finalizeSessionTurnFromMessage({
        spaceId: session.spaceId,
        sessionId: input.sessionId,
        turnId,
        status: isAborted ? "interrupted" : messageKind === "assistant_error" ? "failed" : "completed",
        assistantContent: content,
        assistantText: text,
        provider: input.message.provider ?? null,
        model: input.message.model ?? null,
        stopReason: input.message.stopReason ?? null,
        errorMessage: displayErrorMessage,
        usage: normalizedUsage,
        metaPatch: {
          ...(agentSessionEntryId ? { agentSessionEntryId } : {}),
          ...(typeof messageNode.durationMs === "number" ? { finalMessageDurationMs: messageNode.durationMs } : {}),
        },
      }).catch((error) => {
        logger.warn("[SessionTurn] failed to finalize turn", error);
        return null;
      });
      if (finalizedTurn) {
        await dispatchTurnFinalized({ spaceId: session.spaceId, sessionId: input.sessionId, turn: finalizedTurn }).catch((error) => {
          logger.warn("[SessionTurn] failed to dispatch finalized turn", error);
        });
      }
    }
  }

  const realtimeMessage = {
    ...messageNode,
    role: messageNode.role as "user" | "assistant" | "system",
    meta: (messageNode.meta as Record<string, unknown> | null) ?? null,
    startedAt: messageNode.startedAt instanceof Date ? messageNode.startedAt.toISOString() : null,
    completedAt: messageNode.completedAt instanceof Date ? messageNode.completedAt.toISOString() : null,
    durationMs: messageNode.durationMs ?? null,
    createdAt: messageNode.createdAt instanceof Date ? messageNode.createdAt.toISOString() : new Date().toISOString(),
  };
  const outputs = await buildSessionOutputsForPersistedMessage({
    spaceId: session.spaceId,
    sessionId: session.id,
    message: realtimeMessage,
  });
  await dispatchSessionOutputs(outputs).catch((error) => logger.error("[SpaceSessions] failed to dispatch session outputs", error));

  if (messageRole === "assistant") {
    await enqueueSessionMessagePostprocess({
      sessionId: input.sessionId,
      messageId: messageNode.id,
    });
  }

  return messageNode;
};

export const updateSpaceSessionInfo = async (input: UpdateSessionInfoInput) => {
  const changed: string[] = [];
  const refreshed = await db.transaction(async (tx) => {
    const [session] = await tx.select().from(spaceSessions)
      .where(eq(spaceSessions.id, input.sessionId))
      .for("update")
      .limit(1);
    if (!session || session.spaceId !== input.spaceId) throw new Error("Space session not found");

    const nextTitle = input.title === undefined ? session.title : normalizeSessionTitle(input.title);
    const nextLastMessageAt = input.updatedAt === undefined
      ? session.lastMessageAt
      : input.updatedAt
        ? new Date(input.updatedAt)
        : null;
    let nextMeta = input.meta === undefined
      ? session.meta
      : { ...((session.meta as Record<string, unknown> | null) ?? {}), ...(input.meta ?? {}) };
    if (input.title !== undefined) nextMeta = setSessionTitleMeta(nextMeta, { source: "user" });

    if (nextTitle !== session.title || input.title !== undefined) changed.push("title");
    if (input.updatedAt !== undefined) changed.push("lastMessageAt");
    if (input.meta !== undefined) changed.push("meta");
    if (changed.length === 0) return session;

    const [updated] = await tx.update(spaceSessions).set({
      title: nextTitle,
      lastMessageAt: nextLastMessageAt,
      meta: sanitizePostgresJsonValue(nextMeta),
      updatedAt: new Date(),
    }).where(eq(spaceSessions.id, input.sessionId)).returning();
    return updated ?? session;
  });

  if (changed.length > 0) {
    await dispatchSessionUpdated({ session: refreshed, changed }).catch((error) => {
      logger.warn("[Realtime] failed to dispatch session.updated", error);
    });
  }
  return true;
};

export const listSessionMessages = async (spaceSessionId: string, options?: { cursor?: number; limit?: number; direction?: "older" | "newer" }) => {
  const limit = Math.min(options?.limit ?? 30, 100);
  const direction = options?.direction ?? "older";
  if (options?.cursor === undefined || options?.cursor === null) {
    const rows = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, spaceSessionId)).orderBy(desc(sessionMessages.sequence)).limit(limit);
    return rows.reverse();
  }
  if (direction === "older") {
    const rows = await db.select().from(sessionMessages).where(and(eq(sessionMessages.sessionId, spaceSessionId), lt(sessionMessages.sequence, options.cursor))).orderBy(desc(sessionMessages.sequence)).limit(limit);
    return rows.reverse();
  }
  const cursor = options.cursor ?? 0;
  return db.select().from(sessionMessages).where(and(eq(sessionMessages.sessionId, spaceSessionId), gt(sessionMessages.sequence, cursor))).orderBy(asc(sessionMessages.sequence)).limit(limit);
};

export const enqueueSessionFork = async (input: { spaceId: string; sessionId: string; parentSessionId: string; anchorTurnId: string; anchorSequence: number; anchorEntryId?: string | null }) => {
  const traceCarrier = injectTrace();
  await enqueueAgentSessionForkJob({
    ...input,
    requestId: getOrCreateRequestId(),
    trace: traceCarrier,
  });
};

export const enqueueSessionAbort = async (input: { sessionId: string; actorUserId?: string | null; turnId?: string | null }) => {
  const session = await getSpaceSessionById(input.sessionId);
  if (!session) return;
  const explicitTurnId = input.turnId?.trim() || null;
  const turnId = explicitTurnId ?? ((await db.select({ id: sessionTurns.id })
    .from(sessionTurns)
    .where(and(
      eq(sessionTurns.sessionId, input.sessionId),
      eq(sessionTurns.executionKind, "agent"),
      inArray(sessionTurns.status, ["running", "abort_requested"]),
    ))
    .orderBy(desc(sessionTurns.sequence))
    .limit(1))[0]?.id ?? null);

  if (!turnId) return;

  const [updated] = await db.update(sessionTurns).set({
    status: "abort_requested",
    meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({
      abortRequestedAt: new Date().toISOString(),
      abortActorUserId: input.actorUserId ?? null,
    })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(sessionTurns.id, turnId),
    eq(sessionTurns.sessionId, input.sessionId),
    eq(sessionTurns.executionKind, "agent"),
    inArray(sessionTurns.status, ["running", "abort_requested"]),
  )).returning({ id: sessionTurns.id });

  if (!updated) return;
  await getSessionTurnById(input.sessionId, updated.id)
    .then(async (turn) => {
      if (!turn) return;
      const [hydrated = turn] = await hydrateTurnAuthorProfiles([turn]);
      await dispatchTurnUpdated({ spaceId: session.spaceId, sessionId: input.sessionId, turn: hydrated });
    })
    .catch((error) => logger.warn("[SessionTurn] failed to dispatch abort-requested turn", error));

  await requestAgentTurnAbort({
    spaceId: session.spaceId,
    sessionId: input.sessionId,
    turnId,
    reason: "abort",
    actorUserId: input.actorUserId ?? null,
  });
};

export const waitForSpaceReady = async (spaceId: string, timeoutMs = 30000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const sandbox = await getSpaceSandboxBySpaceId(spaceId);
    if (!sandbox) return false;
    if (isSandboxUsableStatus(sandbox.status)) return true;
    if (sandbox.status === "error") return false;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
};

export const updateSpaceStatus = async (spaceId: string, status: string) => {
  const normalizedStatus =
    status === "running" || status === "ready"
      ? "running"
      : status === "starting" || status === "provisioning"
        ? "provisioning"
        : status === "hibernated" || status === "stopped"
          ? "stopped"
          : status === "deleted" || status === "terminated"
            ? "terminated"
            : status === "error"
              ? "error"
              : "pending";

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  await updateSpaceSandbox({
    spaceId,
    status: normalizedStatus,
    runtimeStatus:
      normalizedStatus === "running"
        ? "healthy"
        : normalizedStatus === "provisioning"
          ? "starting"
          : normalizedStatus === "error"
            ? "unhealthy"
            : "unknown",
    podName: normalizedStatus === "terminated" || normalizedStatus === "stopped" ? null : `sandbox-${spaceId}`,
    lastHeartbeatAt: normalizedStatus === "running" || normalizedStatus === "provisioning" ? new Date() : undefined,
    meta: {
      ...((sandbox?.meta as Record<string, unknown> | null) ?? {}),
      lastStatus: status,
    },
  });
};
