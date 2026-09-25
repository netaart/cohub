import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { sessionTurns } from "@cohub/db";
import type { ContentBlock } from "@cohub/protocol/core";
import { db } from "./db.js";
import { env } from "./env.js";
import type { AgentTurnJobData } from "./queue.js";
import { resolveHarness } from "@cohub/protocol";
import { limitBatchSize } from "./runtime/batch-limit.js";

type TurnRow = {
  id: string;
  sessionId: string;
  userUuid: string | null;
  sequence: number;
  status: string;
  intent: string;
  userContent: ContentBlock[];
  userText: string | null;
  meta: unknown;
  updatedAt: Date | null;
};

type ExecutionBatchMeta = {
  ownerTurnId: string;
  turnIds: string[];
  mergedTurnIds: string[];
  userMessageIds: string[];
  anchorUserMessageId: string | null;
};

export type ClaimedTurnBatch = {
  ownerTurn: TurnRow;
  turns: TurnRow[];
  mergedTurns: TurnRow[];
  executionBatch: ExecutionBatchMeta;
};

export type ClaimResult =
  | { kind: "claimed"; batch: ClaimedTurnBatch }
  | { kind: "busy"; activeTurnId: string; activeUpdatedAt: Date | null; activeStatus: string }
  | { kind: "noop" };

const STALE_ACTIVE_TURN_MS = env.AGENT_STALE_ACTIVE_TURN_MS;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function normalizeTurn(row: Record<string, unknown>): TurnRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    userUuid: typeof row.user_uuid === "string" ? row.user_uuid : null,
    sequence: Number(row.sequence),
    status: String(row.status),
    intent: String(row.intent ?? "steer"),
    userContent: row.user_content as ContentBlock[],
    userText: typeof row.user_text === "string" ? row.user_text : null,
    meta: row.meta ?? null,
    updatedAt: asDate(row.updated_at),
  };
}

const getMetaString = (turn: TurnRow, key: string): string | null => {
  const value = asRecord(turn.meta)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

function getUserMessageId(turn: TurnRow): string {
  return getMetaString(turn, "userMessageId") ?? getMetaString(turn, "messageId") ?? turn.id;
}

function isStaleActiveTurn(turn: TurnRow) {
  const updatedAt = turn.updatedAt?.getTime();
  return updatedAt != null && Number.isFinite(updatedAt) && Date.now() - updatedAt > STALE_ACTIVE_TURN_MS;
}

async function markStaleTurnInterrupted(tx: Transaction, turn: TurnRow) {
  await tx.execute(sql`
    update v2.session_turns
    set status = 'interrupted',
        stop_reason = 'stale_active_recovered',
        summary = ${JSON.stringify({ finishReason: "interrupted", reason: "stale_active_recovered" })}::jsonb,
        meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify({ staleActiveRecoveredAt: new Date().toISOString(), previousStatus: turn.status })}::jsonb,
        completed_at = now(),
        updated_at = now()
    where id = ${turn.id} and status in ('running', 'abort_requested')
  `);
}

function createExecutionBatch(queued: TurnRow[]): ExecutionBatchMeta {
  const userMessageIds = queued.map(getUserMessageId).filter((value): value is string => Boolean(value));
  const owner = queued.at(-1);
  if (!owner) throw new Error("queued turns are required");
  return {
    ownerTurnId: owner.id,
    turnIds: queued.map((turn) => turn.id),
    mergedTurnIds: queued.slice(0, -1).map((turn) => turn.id),
    userMessageIds,
    anchorUserMessageId: userMessageIds.at(-1) ?? null,
  };
}

async function claimQueuedTurns(tx: Transaction, queued: TurnRow[]): Promise<ClaimedTurnBatch | null> {
  const owner = queued.at(-1);
  if (!owner) throw new Error("queued turns are required");
  const merged = queued.slice(0, -1);
  const executionBatch = createExecutionBatch(queued);

  const ownerMeta = { ...asRecord(owner.meta), executionBatch };
  const updatedRows = await tx.execute(sql`
    update v2.session_turns
    set status = 'running',
        started_at = coalesce(started_at, now()),
        updated_at = now(),
        meta = ${JSON.stringify(ownerMeta)}::jsonb
    where id = ${owner.id} and status = 'queued'
    returning id
  `);
  if (updatedRows.length === 0) return null;

  for (const turn of merged) {
    const mergedRows = await tx.execute(sql`
      update v2.session_turns
      set status = 'merged',
          stop_reason = 'merged',
          summary = ${JSON.stringify({ finishReason: "merged", reason: "merge", mergedIntoTurnId: owner.id })}::jsonb,
          meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify({ mergedIntoTurnId: owner.id, mergedAt: new Date().toISOString() })}::jsonb,
          completed_at = now(),
          updated_at = now()
      where id = ${turn.id} and status = 'queued'
      returning id
    `);
    if (mergedRows.length === 0) throw new Error(`failed to merge queued turn ${turn.id}`);
  }

  const updatedOwner = { ...owner, status: "running", meta: ownerMeta, updatedAt: new Date() };
  return {
    ownerTurn: updatedOwner,
    turns: [...merged, updatedOwner],
    mergedTurns: merged,
    executionBatch,
  };
}

export async function claimNextTurnBatch(input: Pick<AgentTurnJobData, "sessionId">): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from v2.space_sessions where id = ${input.sessionId} for update`);

    const activeRows = await tx.execute(sql`
      select id, session_id, user_uuid, sequence, status, intent, user_content, user_text, meta, updated_at
      from v2.session_turns
      where session_id = ${input.sessionId} and execution_kind = 'agent' and status in ('running', 'abort_requested')
      order by sequence asc
      limit 1
    `);
    const active = activeRows[0] ? normalizeTurn(activeRows[0] as Record<string, unknown>) : null;
    if (active) {
      if (resolveHarness(active.meta) === "cohub" && isStaleActiveTurn(active)) {
        await markStaleTurnInterrupted(tx, active);
      } else {
        return { kind: "busy" as const, activeTurnId: active.id, activeUpdatedAt: active.updatedAt, activeStatus: active.status };
      }
    }

    const blockingRows = await tx.execute(sql`
      select sequence
      from v2.session_turns
      where session_id = ${input.sessionId}
        and execution_kind = 'direct_generation'
        and status not in ('completed', 'failed', 'cancelled', 'interrupted', 'merged')
      order by sequence asc
      limit 1
    `);
    const blockingSequenceValue = (blockingRows[0] as Record<string, unknown> | undefined)?.sequence;
    const parsedBlockingSequence = typeof blockingSequenceValue === "number" ? blockingSequenceValue : typeof blockingSequenceValue === "string" ? Number(blockingSequenceValue) : Number.NaN;
    const blockingSequence = Number.isFinite(parsedBlockingSequence) ? parsedBlockingSequence : null;
    const beforeGeneration = blockingSequence === null ? sql`true` : sql`sequence < ${blockingSequence}`;

    const steerRows = await tx.execute(sql`
      select id, session_id, user_uuid, sequence, status, intent, user_content, user_text, meta, updated_at
      from v2.session_turns
      where session_id = ${input.sessionId} and execution_kind = 'agent' and status = 'queued' and intent = 'steer' and ${beforeGeneration}
      order by updated_at asc, sequence asc
      limit 1
    `);
    const steer = steerRows[0] ? normalizeTurn(steerRows[0] as Record<string, unknown>) : null;
    if (steer) {
      const batch = await claimQueuedTurns(tx, [steer]);
      return batch ? { kind: "claimed" as const, batch } : { kind: "noop" as const };
    }

    const followupRows = await tx.execute(sql`
      select id, session_id, user_uuid, sequence, status, intent, user_content, user_text, meta, updated_at
      from v2.session_turns
      where session_id = ${input.sessionId} and execution_kind = 'agent' and status = 'queued' and intent = 'followup' and ${beforeGeneration}
      order by sequence asc
    `);
    const followups = followupRows.map((row) => normalizeTurn(row as Record<string, unknown>));
    if (followups.length === 0) return { kind: "noop" as const };

    const batch = await claimQueuedTurns(tx, limitBatchSize(followups, (turn) => Buffer.byteLength(JSON.stringify(turn.userContent ?? []), "utf8")));
    return batch ? { kind: "claimed" as const, batch } : { kind: "noop" as const };
  });
}

/** Recover the original claim, never collect newer queued follow-ups into a replay. */
export async function loadClaimedTurnBatch(owner: TurnRow): Promise<ClaimedTurnBatch> {
  const recorded = asRecord(asRecord(owner.meta).executionBatch);
  const ids = recorded.turnIds;
  let turns = [owner];
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string")
      || new Set(ids).size !== ids.length || ids.at(-1) !== owner.id || recorded.ownerTurnId !== owner.id) {
      throw new Error("Invalid execution batch");
    }
    if (ids.length > 1) {
      const rows = await db.select().from(sessionTurns)
        .where(and(eq(sessionTurns.sessionId, owner.sessionId), inArray(sessionTurns.id, ids)))
        .orderBy(asc(sessionTurns.sequence));
      if (rows.length !== ids.length || rows.some((row, index) => row.id !== ids[index])
        || rows.slice(0, -1).some((row) => row.status !== "merged" || asRecord(row.meta).mergedIntoTurnId !== owner.id)) {
        throw new Error("Execution batch history mismatch");
      }
      turns = [...rows.slice(0, -1).map((row) => ({ ...row, intent: row.intent ?? "followup" })), owner];
    }
  }
  return { ownerTurn: owner, turns, mergedTurns: turns.slice(0, -1), executionBatch: createExecutionBatch(turns) };
}

export async function enqueueNextRunnableTurn(input: { spaceId: string; sessionId: string; enqueue: (data: AgentTurnJobData) => Promise<unknown> }) {
  const rows = await db.execute(sql`
    select id
    from v2.session_turns
    where session_id = ${input.sessionId} and execution_kind = 'agent' and status = 'queued' and intent in ('steer', 'followup')
    order by case when intent = 'steer' then 0 else 1 end, updated_at asc, sequence asc
    limit 1
  `);
  const turnId = rows
    .map((row) => (row as Record<string, unknown>).id)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!turnId) return null;
  await input.enqueue({ spaceId: input.spaceId, sessionId: input.sessionId, reason: "drain" });
  return turnId;
}

export function resolveBatchAccessMode(batch: { turns: Array<{ meta: unknown }> }): "read_only" | "full_access" {
  return batch.turns.some((turn) => asRecord(turn.meta).accessMode === "read_only") ? "read_only" : "full_access";
}

export function buildUserMessagesForBatch(batch: ClaimedTurnBatch) {
  return batch.turns.map((turn) => {
    const meta = asRecord(turn.meta);
    const userMessageId = getUserMessageId(turn);
    return {
      turnId: turn.id,
      turnSeq: turn.sequence,
      userMessageId,
      content: turn.userContent,
      meta: {
        ...meta,
        userMessageId,
        messageId: typeof meta.messageId === "string" && meta.messageId.trim() ? meta.messageId : userMessageId,
        turnId: typeof meta.turnId === "string" && meta.turnId.trim() ? meta.turnId : turn.id,
      },
    };
  });
}
