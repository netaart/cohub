import type { BoardDocument, BoardPatch } from "@cohub/protocol";
import {
	type BoardDocumentCacheRecord,
	type BoardPendingTransactionCacheRecord,
	idbDelete,
	idbGet,
	idbGetAllByIndex,
	idbPut,
	idbPutGuarded,
} from "$lib/cache/db";
import { boardPendingTransactionKey, getCacheUserKey } from "$lib/cache/keys";

// ─── Pending writes ──────────────────────────────────────────────────────────

/** Persist a local write until the server confirms it, so a reload never loses it. */
export async function writeBoardPendingPatch(input: { spaceId: string; boardId: string; mutationId: string; patch: BoardPatch }) {
	const userKey = getCacheUserKey();
	const now = Date.now();
	const record: BoardPendingTransactionCacheRecord = {
		key: boardPendingTransactionKey(userKey, input.spaceId, input.boardId, input.mutationId),
		userKey,
		spaceId: input.spaceId,
		boardId: input.boardId,
		mutationId: input.mutationId,
		patch: input.patch,
		attemptCount: 0,
		createdAt: now,
		updatedAt: now,
		lastAttemptAt: null,
	};
	await idbPut("board_pending_txs", record);
	return record;
}

export async function deleteBoardPendingPatch(input: { spaceId: string; boardId: string; mutationId: string }) {
	await idbDelete("board_pending_txs", boardPendingTransactionKey(getCacheUserKey(), input.spaceId, input.boardId, input.mutationId));
}

/** Pending writes of a Board, oldest first. */
export async function listBoardPendingPatches(spaceId: string, boardId: string) {
	const rows = await idbGetAllByIndex<BoardPendingTransactionCacheRecord>(
		"board_pending_txs",
		"by_user_space_board",
		IDBKeyRange.only([getCacheUserKey(), spaceId, boardId]),
	);
	return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export async function markBoardPendingPatchAttempt(record: BoardPendingTransactionCacheRecord) {
	await idbPut("board_pending_txs", { ...record, attemptCount: record.attemptCount + 1, lastAttemptAt: Date.now(), updatedAt: Date.now() });
}

// ─── Documents ───────────────────────────────────────────────────────────────

function documentKey(userKey: string, spaceId: string, boardId: string) {
	return boardPendingTransactionKey(userKey, spaceId, boardId, "document");
}

/** The last server document seen for a Board, or null. */
export async function readBoardDocumentCache(spaceId: string, boardId: string) {
	return (await idbGet<BoardDocumentCacheRecord>("board_documents", documentKey(getCacheUserKey(), spaceId, boardId))) ?? null;
}

/** Remember a server document; only a newer version replaces a cached one. */
export async function writeBoardDocumentCache(input: { spaceId: string; boardId: string; version: number; document: BoardDocument }) {
	const userKey = getCacheUserKey();
	const key = documentKey(userKey, input.spaceId, input.boardId);
	await idbPutGuarded<BoardDocumentCacheRecord>(
		"board_documents",
		key,
		(current) => !current || current.version <= input.version,
		{ key, userKey, spaceId: input.spaceId, boardId: input.boardId, version: input.version, document: input.document, updatedAt: Date.now() },
	);
}
