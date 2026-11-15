import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sessionTurns, spaceSessions, spaces } from "@cohub/db";
import type { ContentBlock } from "@cohub/protocol/core";
import {
  failedBeforeRun,
  formatSpaceMention,
  isSessionTurnReplyStatus,
  MAX_REPLY_WAKE_DEPTH,
  readExecutionBatchTurnIds,
  readSessionTurnOrigin,
  readSessionTurnReply,
  type SessionTurnOrigin,
  type SessionTurnReply,
  type SessionTurnReplyMode,
  type SessionTurnReplyStatus,
} from "@cohub/protocol/model";
import { harnessSchema } from "@cohub/protocol/runtime";
import { hasPermission, type PermissionStore } from "../permissions/index.js";
import type { SessionServices } from "./service.js";

type TurnRow = typeof sessionTurns.$inferSelect;
type Database = PostgresJsDatabase<Record<string, unknown>>;
type PromptPermission = "session.prompt.readonly" | "session.prompt.fullaccess";

export const SESSION_REPLY_SOURCE = "reply";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

function statusNote(status: SessionTurnReplyStatus, errorMessage: string | null, empty: boolean) {
  if (status === "failed") return errorMessage ? `(The reply failed: ${errorMessage})` : "(The reply failed.)";
  if (status === "interrupted") return "(Stopped before finishing.)";
  if (status === "cancelled") return "(Cancelled before it started.)";
  return empty ? "(The reply has no text.)" : null;
}

export function buildTurnReplyContent(input: { result: TurnRow; spaceId: string; spaceName: string }): ContentBlock[] {
  const { result } = input;
  const status: SessionTurnReplyStatus = isSessionTurnReplyStatus(result.status) ? result.status : "completed";
  const body = (result.assistantContent ?? []).filter((block) =>
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0));
  if (body.length === 0 && text(result.assistantText)) body.push({ type: "text", text: result.assistantText as string });
  const note = statusNote(status, text(result.errorMessage), body.length === 0);
  const mention = formatSpaceMention({ spaceId: input.spaceId, sessionId: result.sessionId, label: input.spaceName });
  return [
    { type: "text", text: `Reply from ${mention}:`, _meta: { reply: "header" } },
    ...body,
    ...(note ? [{ type: "text" as const, text: note, _meta: { reply: "status", status } }] : []),
  ];
}

export type TurnReplyDependencies = {
  db: Database;
  services: Pick<SessionServices, "recordNote" | "submitPrompt">;
  permissions: PermissionStore;
  logger?: Pick<Console, "warn">;
};

type PendingReply = { child: TurnRow; reply: SessionTurnReply; origin: SessionTurnOrigin };

export async function deliverTurnReplies(deps: TurnReplyDependencies, turnId: string) {
  const [found] = await deps.db.select({ turn: sessionTurns, spaceId: spaceSessions.spaceId, spaceName: spaces.name }).from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .innerJoin(spaces, eq(spaces.id, spaceSessions.spaceId))
    .where(eq(sessionTurns.id, turnId)).limit(1);
  if (!found || !isSessionTurnReplyStatus(found.turn.status)) return [];
  const { turn: result, spaceId } = found;
  const batch = readExecutionBatchTurnIds(result.meta);
  const children = batch.length > 1
    ? await deps.db.select().from(sessionTurns).where(and(eq(sessionTurns.sessionId, result.sessionId), inArray(sessionTurns.id, batch)))
    : [result];
  const pending = children.flatMap((child): PendingReply[] => {
    const reply = readSessionTurnReply(child.meta);
    const origin = readSessionTurnOrigin(child.meta, spaceId);
    return reply && origin && origin.sessionId !== result.sessionId ? [{ child, reply, origin }] : [];
  });
  if (pending.length === 0) return [];

  const content = buildTurnReplyContent({ result, spaceId, spaceName: found.spaceName });
  const delivered: Array<{ turnId: string; mode: SessionTurnReplyMode }> = [];
  for (const item of pending) {
    const mode = await deliverReply(deps, { ...item, spaceId, content });
    if (mode) delivered.push({ turnId: item.child.id, mode });
  }
  return delivered;
}

async function findDelivered(db: Database, sessionId: string, clientMessageId: string) {
  const [turn] = await db.select({ executionKind: sessionTurns.executionKind }).from(sessionTurns).where(and(
    eq(sessionTurns.sessionId, sessionId),
    sql`${sessionTurns.meta}->>'clientMessageId' = ${clientMessageId}`,
  )).limit(1);
  return turn ?? null;
}

async function deliverReply(
  deps: TurnReplyDependencies,
  input: PendingReply & { spaceId: string; content: ContentBlock[] },
): Promise<SessionTurnReplyMode | null> {
  const { child, origin } = input;
  const userUuid = child.userUuid;
  if (!userUuid) return null;
  const can = (permission: PromptPermission) => hasPermission({
    store: deps.permissions,
    user: { uuid: userUuid },
    permission,
    context: { spaceId: origin.spaceId, sessionId: origin.sessionId },
  });
  const delivery = {
    userUuid,
    content: input.content,
    clientMessageId: `reply:${child.id}`,
    origin: {
      kind: "reply",
      spaceId: input.spaceId,
      sessionId: child.sessionId,
      turnId: child.id,
      depth: Math.max(0, (origin.depth ?? 1) - 1),
    } satisfies SessionTurnOrigin,
  };

  const existing = await findDelivered(deps.db, origin.sessionId, delivery.clientMessageId);
  if (existing) return existing.executionKind === "note" ? "note" : "prompt";

  if (!failedBeforeRun(child) && input.reply.mode === "prompt" && (origin.depth ?? 1) <= MAX_REPLY_WAKE_DEPTH && await wakeCaller(deps, origin, delivery, can)) {
    return "prompt";
  }
  if (!(await can("session.prompt.readonly"))) {
    deps.logger?.warn("[SessionReply] sender can no longer write to the caller Session", { turnId: child.id, sessionId: origin.sessionId });
    return null;
  }
  await deps.services.recordNote({
    sessionId: origin.sessionId,
    userUuid,
    content: delivery.content,
    clientMessageId: delivery.clientMessageId,
    meta: { source: SESSION_REPLY_SOURCE, origin: delivery.origin },
  });
  return "note";
}

async function wakeCaller(
  deps: TurnReplyDependencies,
  origin: SessionTurnOrigin,
  delivery: { userUuid: string; content: ContentBlock[]; clientMessageId: string; origin: SessionTurnOrigin },
  can: (permission: PromptPermission) => Promise<boolean>,
) {
  const [caller] = await deps.db.select({ meta: sessionTurns.meta }).from(sessionTurns)
    .where(and(eq(sessionTurns.id, origin.turnId), eq(sessionTurns.sessionId, origin.sessionId))).limit(1);
  const meta = record(caller?.meta);
  // App-delegated authority is scoped to the original request; never reuse it for a new run.
  if (!caller || record(meta.context).auth) return false;
  const accessMode = meta.accessMode === "read_only" ? "read_only" : "full_access";
  if (!(await can(accessMode === "read_only" ? "session.prompt.readonly" : "session.prompt.fullaccess"))) return false;

  const harness = harnessSchema.safeParse(meta.harness);
  try {
    await deps.services.submitPrompt({
      spaceId: origin.spaceId,
      sessionId: origin.sessionId,
      userId: delivery.userUuid,
      clientMessageId: delivery.clientMessageId,
      content: delivery.content,
      source: SESSION_REPLY_SOURCE,
      origin: delivery.origin,
      harness: harness.success ? harness.data : null,
      model: text(meta.model),
      provider: text(meta.provider),
      accessMode,
      intent: "followup",
    });
    return true;
  } catch (error) {
    deps.logger?.warn("[SessionReply] could not wake the caller", { sessionId: origin.sessionId, error });
    return Boolean(await findDelivered(deps.db, origin.sessionId, delivery.clientMessageId));
  }
}
