import "dotenv/config";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: "apps/api/.env", override: false });

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@cohub/db";
import {
  checkpointForkReference,
  extractTurnReferences,
  modReference,
  sessionForkReference,
  spaceForkReference,
  turnTriggerReference,
  writeReferences,
  type ReferenceInput,
} from "@cohub/core/references";
import type { ContentBlock } from "@cohub/protocol/core";

/**
 * Backfill / rebuild the resource_references index from source tables.
 *
 * Source tables remain the sole source of truth; this index is fully
 * reconstructable at any time. The script is idempotent (writeReferences
 * upserts by identity) and safe to re-run, so it doubles as disaster recovery
 * when live double-writes miss an event.
 *
 * Turn content is loaded efficiently through the indexed turn_id column while
 * retaining the session_id predicate as an integrity boundary.
 *
 * Usage:
 *   tsx scripts/backfill-resource-references.ts \
 *     [--batch-size N] [--write-batch-size N] [--after-turn UUID] \
 *     [--max-turns N] [--dry-run] [--reset]
 *
 *   --reset       Truncate first for a true rebuild (drops references whose
 *                 source relationship no longer exists). Without it, runs as
 *                 idempotent upsert.
 *   --after-turn  Resume after this turn id (exclusive), keyed on turn.id order.
 *   --max-turns   Stop after processing this many turns (smoke / canary).
 */

const connectionString =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cohub";
const dbClient = postgres(connectionString, { prepare: false, max: 4 });
const db = drizzle(dbClient, { schema });

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5_000;
const DEFAULT_WRITE_BATCH_SIZE = 2_000;

type Args = {
  batchSize: number;
  writeBatchSize: number;
  afterTurn: string | null;
  maxTurns: number | null;
  dryRun: boolean;
  reset: boolean;
};

function parseArgs(rawArgv: string[]): Args {
  const argv = rawArgv.filter((arg) => arg !== "--");
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const batchSize = Math.min(
    Math.max(Number(readValue("--batch-size") ?? DEFAULT_BATCH_SIZE), 1),
    MAX_BATCH_SIZE,
  );
  const writeBatchSize = Math.min(
    Math.max(Number(readValue("--write-batch-size") ?? DEFAULT_WRITE_BATCH_SIZE), 1),
    20_000,
  );
  const maxTurnsRaw = readValue("--max-turns");
  const maxTurns = maxTurnsRaw != null ? Math.max(Number(maxTurnsRaw), 1) : null;
  return {
    batchSize,
    writeBatchSize,
    afterTurn: readValue("--after-turn") ?? null,
    maxTurns: Number.isFinite(maxTurns) ? maxTurns : null,
    dryRun: argv.includes("--dry-run"),
    reset: argv.includes("--reset"),
  };
}

const asContentBlocks = (value: unknown): ContentBlock[] | null =>
  Array.isArray(value) ? (value as ContentBlock[]) : null;

const formatRate = (count: number, elapsedMs: number) => {
  if (elapsedMs <= 0) return "n/a";
  return `${((count * 1000) / elapsedMs).toFixed(1)}/s`;
};

async function flush(
  references: ReferenceInput[],
  dryRun: boolean,
  writeBatchSize: number,
) {
  if (references.length === 0) return 0;
  if (dryRun) return references.length;
  for (let offset = 0; offset < references.length; offset += writeBatchSize) {
    await writeReferences(db, references.slice(offset, offset + writeBatchSize));
  }
  return references.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  console.log(
    `[backfill-references] start batchSize=${args.batchSize} writeBatchSize=${args.writeBatchSize} dryRun=${args.dryRun} reset=${args.reset} afterTurn=${args.afterTurn ?? "-"} maxTurns=${args.maxTurns ?? "-"}`,
  );

  // With --reset, truncate first so the run is a true rebuild: references whose
  // underlying relationship no longer exists (e.g. an unmounted mod) are dropped
  // rather than lingering as stale rows. Without it, the run is an idempotent
  // upsert that only adds/refreshes.
  if (args.reset && !args.dryRun) {
    await db.execute(sql`TRUNCATE TABLE ${schema.resourceReferences}`);
    console.log("[backfill-references] truncated resource_references");
  }

  const totals = {
    sessionFork: 0,
    spaceFork: 0,
    checkpointFork: 0,
    mod: 0,
    turn: 0,
    turnsScanned: 0,
  };

  // --- Structural: session forks ---
  {
    let cursor: string | null = null;
    for (;;) {
      const rows = await db
        .select()
        .from(schema.sessionForks)
        .where(cursor ? gt(schema.sessionForks.id, cursor) : undefined)
        .orderBy(asc(schema.sessionForks.id))
        .limit(args.batchSize);
      if (rows.length === 0) break;
      const refs = rows.map((row) =>
        sessionForkReference({
          spaceId: row.spaceId,
          parentSessionId: row.parentSessionId,
          childSessionId: row.childSessionId,
          anchorTurnId: row.anchorTurnId,
          createdBy: row.createdBy,
        }),
      );
      totals.sessionFork += await flush(refs, args.dryRun, args.writeBatchSize);
      cursor = rows[rows.length - 1]?.id ?? null;
      if (rows.length < args.batchSize) break;
    }
    console.log(`[backfill-references] sessionFork done count=${totals.sessionFork}`);
  }

  // --- Structural: space forks (spaces with a base checkpoint) ---
  {
    let cursor: string | null = null;
    for (;;) {
      const rows = await db
        .select({
          id: schema.spaces.id,
          baseCheckpointId: schema.spaces.baseCheckpointId,
        })
        .from(schema.spaces)
        .where(cursor ? gt(schema.spaces.id, cursor) : undefined)
        .orderBy(asc(schema.spaces.id))
        .limit(args.batchSize);
      if (rows.length === 0) break;
      const refs = rows
        .filter((row) => row.baseCheckpointId)
        .map((row) =>
          spaceForkReference({
            spaceId: row.id,
            baseCheckpointId: row.baseCheckpointId as string,
          }),
        );
      totals.spaceFork += await flush(refs, args.dryRun, args.writeBatchSize);
      cursor = rows[rows.length - 1]?.id ?? null;
      if (rows.length < args.batchSize) break;
    }
    console.log(`[backfill-references] spaceFork done count=${totals.spaceFork}`);
  }

  // --- Structural: checkpoint forks ---
  {
    let cursor: string | null = null;
    for (;;) {
      const rows = await db
        .select({
          id: schema.checkpoints.id,
          spaceId: schema.checkpoints.spaceId,
          parentCheckpointId: schema.checkpoints.parentCheckpointId,
          rootCheckpointId: schema.checkpoints.rootCheckpointId,
        })
        .from(schema.checkpoints)
        .where(cursor ? gt(schema.checkpoints.id, cursor) : undefined)
        .orderBy(asc(schema.checkpoints.id))
        .limit(args.batchSize);
      if (rows.length === 0) break;
      const refs = rows
        .filter((row) => row.parentCheckpointId)
        .map((row) =>
          checkpointForkReference({
            spaceId: row.spaceId,
            checkpointId: row.id,
            parentCheckpointId: row.parentCheckpointId as string,
            rootCheckpointId: row.rootCheckpointId,
          }),
        );
      totals.checkpointFork += await flush(refs, args.dryRun, args.writeBatchSize);
      cursor = rows[rows.length - 1]?.id ?? null;
      if (rows.length < args.batchSize) break;
    }
    console.log(`[backfill-references] checkpointFork done count=${totals.checkpointFork}`);
  }

  // --- Structural: mods ---
  {
    let cursor: string | null = null;
    for (;;) {
      const rows = await db
        .select()
        .from(schema.spaceMods)
        .where(cursor ? gt(schema.spaceMods.id, cursor) : undefined)
        .orderBy(asc(schema.spaceMods.id))
        .limit(args.batchSize);
      if (rows.length === 0) break;
      const refs = rows.map((row) =>
        modReference({
          spaceId: row.spaceId,
          modSpaceId: row.modSpaceId,
          mountSlug: row.mountSlug,
        }),
      );
      totals.mod += await flush(refs, args.dryRun, args.writeBatchSize);
      cursor = rows[rows.length - 1]?.id ?? null;
      if (rows.length < args.batchSize) break;
    }
    console.log(`[backfill-references] mod done count=${totals.mod}`);
  }

  // --- Turn-derived: mentions, tool calls, agent file access ---
  {
    let cursor: string | null = args.afterTurn;
    const turnPhaseStartedAt = Date.now();
    for (;;) {
      if (args.maxTurns != null && totals.turnsScanned >= args.maxTurns) break;

      const limit =
        args.maxTurns != null
          ? Math.min(args.batchSize, args.maxTurns - totals.turnsScanned)
          : args.batchSize;
      if (limit <= 0) break;

      const batchStartedAt = Date.now();
      const rows = await db
        .select({
          id: schema.sessionTurns.id,
          sessionId: schema.sessionTurns.sessionId,
          userContent: schema.sessionTurns.userContent,
          userText: schema.sessionTurns.userText,
          assistantContent: schema.sessionTurns.assistantContent,
          meta: schema.sessionTurns.meta,
          spaceId: schema.spaceSessions.spaceId,
        })
        .from(schema.sessionTurns)
        .innerJoin(
          schema.spaceSessions,
          eq(schema.sessionTurns.sessionId, schema.spaceSessions.id),
        )
        .where(cursor ? gt(schema.sessionTurns.id, cursor) : undefined)
        .orderBy(asc(schema.sessionTurns.id))
        .limit(limit);
      if (rows.length === 0) break;

      // Aggregate assistant content across all messages in each turn so tool
      // calls from intermediate steps are not lost (matches the live indexer).
      // Query by indexed turn_id and retain session_id as an integrity boundary,
      // so busy session histories are never materialized as a whole.
      const turnIds = rows.map((row) => row.id);
      const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
      const assistantContentByTurn = new Map<string, ContentBlock[]>();

      if (sessionIds.length > 0 && turnIds.length > 0) {
        const messageRows = await db
          .select({
            turnId: schema.sessionMessages.turnId,
            content: schema.sessionMessages.content,
          })
          .from(schema.sessionMessages)
          .where(
            and(
              inArray(schema.sessionMessages.sessionId, sessionIds),
              inArray(schema.sessionMessages.turnId, turnIds),
              eq(schema.sessionMessages.role, "assistant"),
            ),
          );

        for (const message of messageRows) {
          if (!message.turnId) continue;
          const blocks = asContentBlocks(message.content);
          if (!blocks) continue;
          const existing = assistantContentByTurn.get(message.turnId);
          if (existing) existing.push(...blocks);
          else assistantContentByTurn.set(message.turnId, [...blocks]);
        }
      }

      const refs: ReferenceInput[] = [];
      for (const row of rows) {
        const trigger = turnTriggerReference(row);
        if (trigger) refs.push(trigger);
        refs.push(
          ...extractTurnReferences({
            spaceId: row.spaceId,
            sessionId: row.sessionId,
            turnId: row.id,
            userContent: asContentBlocks(row.userContent),
            userText: row.userText,
            assistantContent:
              assistantContentByTurn.get(row.id) ?? asContentBlocks(row.assistantContent),
          }),
        );
      }
      const written = await flush(refs, args.dryRun, args.writeBatchSize);
      totals.turn += written;
      totals.turnsScanned += rows.length;
      cursor = rows[rows.length - 1]?.id ?? null;

      const batchMs = Date.now() - batchStartedAt;
      const phaseMs = Date.now() - turnPhaseStartedAt;
      console.log(
        `[backfill-references] turn batch turns=${rows.length} refs=${written} scanned=${totals.turnsScanned} turnRefs=${totals.turn} cursor=${cursor} batchMs=${batchMs} msgsByTurn=${assistantContentByTurn.size} rate=${formatRate(totals.turnsScanned, phaseMs)}`,
      );

      if (rows.length < limit) break;
    }
    console.log(
      `[backfill-references] turn done turnsScanned=${totals.turnsScanned} refs=${totals.turn} elapsedMs=${Date.now() - turnPhaseStartedAt}`,
    );
  }

  console.log("[backfill-references] done", {
    ...totals,
    elapsedMs: Date.now() - startedAt,
  });
  await dbClient.end();
}

main().catch(async (error) => {
  console.error("[backfill-references] failed", error);
  await dbClient.end();
  process.exit(1);
});
