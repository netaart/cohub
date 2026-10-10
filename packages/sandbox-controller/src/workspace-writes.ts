import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { spaceSandboxes } from "@cohub/db";

type WriteDb = PostgresJsDatabase<Record<string, unknown>>;
type WriteLogger = { error(message: string, ...args: unknown[]): void };

/**
 * Store of the workspace write generation. It is the space sandbox row, the
 * record every direct writer already reads to decide whether a sandbox can
 * take the write instead.
 */
export type WorkspaceWriteStore = {
  bump(spaceId: string): Promise<void>;
  read(spaceId: string): Promise<{ epoch: string; gen: number } | null>;
};

export function createWorkspaceWriteStore(db: WriteDb): WorkspaceWriteStore {
  return {
    async bump(spaceId) {
      await db.update(spaceSandboxes)
        .set({ workspaceWriteGen: sql`${spaceSandboxes.workspaceWriteGen} + 1` })
        .where(eq(spaceSandboxes.spaceId, spaceId));
    },
    async read(spaceId) {
      const [row] = await db.select({ epoch: spaceSandboxes.id, gen: spaceSandboxes.workspaceWriteGen })
        .from(spaceSandboxes)
        .where(eq(spaceSandboxes.spaceId, spaceId))
        .limit(1);
      return row ?? null;
    },
  };
}

/**
 * Runs a write that lands on the workspace volume without passing through the
 * sandbox, so the sandbox's file watcher never sees it. The write generation
 * is bumped before the write, which fails the write when it cannot be
 * recorded, and again once it ends. Agent searches carry the generation, and
 * the sandbox answers from its index only after a rescan that started after
 * the newest one. Without a sandbox row there is no index yet to protect.
 */
export async function runDirectWorkspaceWrite<T>(
  store: WorkspaceWriteStore,
  spaceId: string,
  write: () => Promise<T>,
  logger: WriteLogger,
): Promise<T> {
  await store.bump(spaceId);
  try {
    return await write();
  } finally {
    // The sandbox rescans again about a minute after the newest generation
    // it saw, so losing this bump leaves uncovered only a write that ran
    // longer than that.
    await store.bump(spaceId).catch((error) => {
      logger.error(`[WorkspaceWrites] failed to record the end of a direct write spaceId=${spaceId}`, error);
    });
  }
}

/**
 * The write token an agent search sends: `<epoch>:<generation>`. The epoch is
 * the sandbox row id, so a recreated row never reuses an old generation. Null
 * when the space has no sandbox row, which also means it has no index.
 */
export async function readWorkspaceWriteToken(store: WorkspaceWriteStore, spaceId: string): Promise<string | null> {
  const record = await store.read(spaceId);
  return record ? `${record.epoch}:${record.gen}` : null;
}
