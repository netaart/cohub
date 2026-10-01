import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { boardCheckpoints } from "@cohub/db";
import {
  BOARD_PROTOCOL_VERSION,
  BOARD_SNAPSHOT_KIND,
  type BoardPatch,
  isBoardPath,
  parseBoardManifest,
  serializeBoardManifest,
  upgradeBoardSnapshotV2,
} from "@cohub/protocol";
import { captureBoardSnapshots, createBoard, deleteBoard } from "@cohub/core/board";
import { db } from "../db.js";

async function listBoardFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await listBoardFiles(root, path));
    else if (entry.isFile() && isBoardPath(entry.name)) paths.push(path);
  }
  return paths;
}

export async function saveBoardCheckpointSnapshots(input: { checkpointId: string; spaceId: string }) {
  const snapshots = await captureBoardSnapshots(db, { spaceId: input.spaceId });
  if (snapshots.length > 0) {
    await db.insert(boardCheckpoints).values(snapshots.map((snapshot) => ({
      checkpointId: input.checkpointId,
      sourceBoardId: snapshot.id,
      sourceSpaceId: input.spaceId,
      sourceVersion: snapshot.boardVersion,
      snapshot: snapshot as unknown as Record<string, unknown>,
    })));
  }
  return { count: snapshots.length };
}

export function boardSnapshotDocument(snapshot: Record<string, unknown>): { title?: string; document: BoardPatch } {
  if (snapshot.kind !== BOARD_SNAPSHOT_KIND) throw new Error("Not a Board snapshot");
  if (snapshot.version === 2) {
    const board = snapshot.board as { title?: string } | undefined;
    return { title: board?.title, document: upgradeBoardSnapshotV2(snapshot) };
  }
  if (snapshot.version !== BOARD_PROTOCOL_VERSION) throw new Error(`Unsupported Board snapshot version: ${String(snapshot.version)}`);
  return {
    title: typeof snapshot.title === "string" ? snapshot.title : undefined,
    document: { board: snapshot.board, items: snapshot.items, animations: snapshot.animations } as BoardPatch,
  };
}

export async function restoreBoardCheckpointSnapshots(input: {
  checkpointId: string;
  targetSpaceId: string;
  workspaceDir: string;
}) {
  const snapshots = await db.select().from(boardCheckpoints).where(eq(boardCheckpoints.checkpointId, input.checkpointId));
  const snapshotBySourceId = new Map(snapshots.map((snapshot) => [snapshot.sourceBoardId, snapshot]));
  const files = await listBoardFiles(resolve(input.workspaceDir));
  const restored: Array<{ path: string; boardId: string }> = [];

  for (const absolutePath of files) {
    let manifest: ReturnType<typeof parseBoardManifest>;
    try {
      manifest = parseBoardManifest(await readFile(absolutePath, "utf8"));
    } catch {
      continue;
    }
    const source = snapshotBySourceId.get(manifest.boardId);
    if (!source) continue;
    const { title, document } = boardSnapshotDocument(source.snapshot);
    const boardId = crypto.randomUUID();
    try {
      await createBoard(db, {
        spaceId: input.targetSpaceId,
        boardId,
        title: title ?? manifest.title,
        actorId: "system",
        document,
        mutationId: `restore:${input.checkpointId}:${source.sourceBoardId}`,
      });
      const temporaryPath = `${absolutePath}.cohub-restore-${boardId}.tmp`;
      try {
        await writeFile(temporaryPath, serializeBoardManifest({ ...manifest, boardId }), { flag: "wx" });
        await rename(temporaryPath, absolutePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      restored.push({ path: relative(resolve(input.workspaceDir), absolutePath).replaceAll("\\", "/"), boardId });
    } catch (error) {
      await deleteBoard(db, { spaceId: input.targetSpaceId, boardId }).catch(() => undefined);
      throw error;
    }
  }
  return { count: restored.length, restored };
}
