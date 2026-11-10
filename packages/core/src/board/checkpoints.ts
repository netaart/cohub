import { and, eq } from "drizzle-orm";
import { boardCheckpoints, checkpoints } from "@cohub/db";
import { type BoardCheckpointReadResult, boardSnapshotPatch } from "@cohub/protocol";
import { BoardError, type BoardDatabase } from "./store.js";

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Board snapshots are keyed by the checkpoint that captured them. A fork alias
 * shares its source checkpoint's files, so it reads that checkpoint's snapshots.
 */
export async function readBoardCheckpoint(
	db: BoardDatabase,
	input: { spaceId: string; checkpointId: string; boardId: string },
): Promise<BoardCheckpointReadResult> {
	const [checkpoint] = await db
		.select({ id: checkpoints.id, meta: checkpoints.meta })
		.from(checkpoints)
		.where(and(eq(checkpoints.id, input.checkpointId), eq(checkpoints.spaceId, input.spaceId)))
		.limit(1);
	if (!checkpoint) throw new BoardError(404, "CHECKPOINT_NOT_FOUND", "Checkpoint not found.");
	const meta = isRecord(checkpoint.meta) ? checkpoint.meta : {};
	const snapshotCheckpointId = meta.kind === "fork_alias" && typeof meta.sourceCheckpointId === "string" ? meta.sourceCheckpointId : checkpoint.id;
	const [row] = await db
		.select({ sourceVersion: boardCheckpoints.sourceVersion, snapshot: boardCheckpoints.snapshot, createdAt: boardCheckpoints.createdAt })
		.from(boardCheckpoints)
		.where(and(eq(boardCheckpoints.checkpointId, snapshotCheckpointId), eq(boardCheckpoints.sourceBoardId, input.boardId)))
		.limit(1);
	if (!row) throw new BoardError(404, "BOARD_NOT_FOUND", "This checkpoint has no snapshot of the Board.");
	const { board, items, animations } = boardSnapshotPatch(row.snapshot);
	const snapshot = row.snapshot;
	return {
		id: input.boardId,
		title: typeof snapshot.title === "string" ? snapshot.title : "",
		version: row.sourceVersion,
		updatedAt: null,
		board: (board ?? {}) as Record<string, unknown>,
		items: (items ?? {}) as Record<string, Record<string, unknown>>,
		animations: (animations ?? {}) as Record<string, Record<string, unknown>>,
		playback: null,
		checkpointId: checkpoint.id,
		capturedAt: typeof snapshot.capturedAt === "string" ? snapshot.capturedAt : row.createdAt.toISOString(),
	};
}
