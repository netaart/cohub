import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { spaceWorkspaceWriters, spaceWorkspaceWrites } from "@cohub/db";

type WriteDb = PostgresJsDatabase<Record<string, unknown>>;
type WriteTx = Parameters<Parameters<WriteDb["transaction"]>[0]>[0];
type WriteLogger = { error(message: string, ...args: unknown[]): void };

/**
 * How long a write by another NFS client can stay invisible to the sandbox's
 * attribute and directory caches (acregmax and acdirmax default to 60 s),
 * plus a margin. The sandbox trusts a rescan that starts after this.
 */
export const DIRECT_WRITE_SETTLE_MS = 70_000;
/**
 * Lease a running writer renews every DIRECT_WRITE_RENEW_MS. A writer that
 * cannot record its end keeps searches held back until its lease lapses, so
 * renewals may fail for LEASE - SETTLE - RENEW before the end without letting
 * searches resume early. A crashed writer holds them back that long, too.
 */
export const DIRECT_WRITE_LEASE_MS = 10 * 60_000;
export const DIRECT_WRITE_RENEW_MS = 20_000;

/** Record of the direct writes to each space's workspace volume. */
export type WorkspaceWriteStore = {
  /**
   * Records `writerId` as running for a lease from now and bumps the write
   * generation. Lapsed writers of the space are dropped.
   */
  hold(spaceId: string, writerId: string): Promise<void>;
  /** Bumps the write generation, holds searches back until settled, and drops `writerId`. */
  release(spaceId: string, writerId: string): Promise<void>;
  /**
   * The write generation, and whether no writer runs and the last finished
   * write has settled. Null before any direct write.
   */
  read(spaceId: string): Promise<{ gen: number; settled: boolean } | null>;
};

const after = (ms: number) => sql`now() + make_interval(secs => ${ms / 1000}::double precision)`;

export function createWorkspaceWriteStore(db: WriteDb): WorkspaceWriteStore {
  const bump = (tx: WriteTx, spaceId: string, settledAt: ReturnType<typeof sql>) =>
    tx.insert(spaceWorkspaceWrites)
      .values({ spaceId, gen: 1, settledAt })
      .onConflictDoUpdate({
        target: spaceWorkspaceWrites.spaceId,
        set: {
          gen: sql`${spaceWorkspaceWrites.gen} + 1`,
          settledAt: sql`greatest(${spaceWorkspaceWrites.settledAt}, excluded.settled_at)`,
        },
      });
  // Both transactions lock the space's generation row first, so holds and
  // releases of one space run one after another and cannot deadlock.
  return {
    async hold(spaceId, writerId) {
      await db.transaction(async (tx) => {
        await bump(tx, spaceId, sql`now()`);
        await tx.delete(spaceWorkspaceWriters)
          .where(and(eq(spaceWorkspaceWriters.spaceId, spaceId), lt(spaceWorkspaceWriters.leaseUntil, sql`now()`)));
        await tx.insert(spaceWorkspaceWriters)
          .values({ id: writerId, spaceId, leaseUntil: after(DIRECT_WRITE_LEASE_MS) })
          .onConflictDoUpdate({ target: spaceWorkspaceWriters.id, set: { leaseUntil: sql`excluded.lease_until` } });
      });
    },
    async release(spaceId, writerId) {
      await db.transaction(async (tx) => {
        await bump(tx, spaceId, after(DIRECT_WRITE_SETTLE_MS));
        await tx.delete(spaceWorkspaceWriters).where(eq(spaceWorkspaceWriters.id, writerId));
      });
    },
    async read(spaceId) {
      const [row] = await db.select({
        gen: spaceWorkspaceWrites.gen,
        settled: sql<boolean>`${spaceWorkspaceWrites.settledAt} <= now() and not exists (
          select 1 from ${spaceWorkspaceWriters}
          where ${spaceWorkspaceWriters.spaceId} = ${spaceWorkspaceWrites.spaceId}
            and ${spaceWorkspaceWriters.leaseUntil} > now())`,
      })
        .from(spaceWorkspaceWrites)
        .where(eq(spaceWorkspaceWrites.spaceId, spaceId))
        .limit(1);
      return row ?? null;
    },
  };
}

/**
 * Runs a write that lands on the workspace volume without passing through the
 * sandbox, so the sandbox's file watcher never sees it. Searches are held back
 * while the write runs and for DIRECT_WRITE_SETTLE_MS after it ends; the write
 * fails when that hold cannot be recorded. Every renewal bumps the generation,
 * so a sandbox that rescanned while a lease lapsed rescans again.
 */
export async function runDirectWorkspaceWrite<T>(
  store: WorkspaceWriteStore,
  spaceId: string,
  write: () => Promise<T>,
  logger: WriteLogger,
): Promise<T> {
  const writerId = randomUUID();
  await store.hold(spaceId, writerId);
  // One renewal at a time, drained before the release so that a late one
  // cannot recreate the released writer.
  let renewing: Promise<void> | null = null;
  const renewal = setInterval(() => {
    renewing ??= store.hold(spaceId, writerId)
      .catch((error) => {
        logger.error(`[WorkspaceWrites] failed to renew a direct write lease spaceId=${spaceId}`, error);
      })
      .finally(() => {
        renewing = null;
      });
  }, DIRECT_WRITE_RENEW_MS);
  renewal.unref();
  try {
    return await write();
  } finally {
    clearInterval(renewal);
    await renewing;
    await store.release(spaceId, writerId).catch((error) => {
      logger.error(`[WorkspaceWrites] failed to record the end of a direct write spaceId=${spaceId}`, error);
    });
  }
}

/**
 * The write token an agent search sends: `<epoch>:<generation>`, where the
 * epoch is the space id because the record is never reset. Null while a
 * direct write runs or may still be hidden from the sandbox; the search must
 * not use the index then.
 */
export async function readWorkspaceWriteToken(store: WorkspaceWriteStore, spaceId: string): Promise<string | null> {
  const record = await store.read(spaceId);
  if (!record) return `${spaceId}:0`;
  return record.settled ? `${spaceId}:${record.gen}` : null;
}
