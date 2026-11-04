import type { BoardPatch } from "@cohub/protocol";
import {
	type BoardPlaySaveCacheRecord,
	idbDelete,
	idbGet,
	idbPut,
} from "$lib/cache/db";
import {
	boardPlaySaveKey,
	canUseUserScopedCache,
	getCacheUserKeyAsync,
} from "$lib/cache/keys";

export type BoardPlaySaveRef = {
	appId: string;
	versionId: string;
	boardId: string;
	boardVersion: number;
};

export type BoardPlayStore = {
	read(): Promise<BoardPatch | null>;
	write(overlay: BoardPatch | null): Promise<void>;
};

export async function openBoardPlayStore(
	ref: BoardPlaySaveRef,
): Promise<BoardPlayStore | null> {
	const userKey = await getCacheUserKeyAsync();
	if (!canUseUserScopedCache(userKey)) return null;
	const key = boardPlaySaveKey(userKey, ref.appId, ref.versionId);
	return {
		async read() {
			const record = await idbGet<BoardPlaySaveCacheRecord>(
				"board_play_saves",
				key,
			);
			if (!record) return null;
			if (
				record.versionId !== ref.versionId ||
				record.boardId !== ref.boardId ||
				record.boardVersion !== ref.boardVersion
			) {
				await idbDelete("board_play_saves", key);
				return null;
			}
			void idbPut("board_play_saves", {
				...record,
				lastAccessedAt: Date.now(),
			});
			return record.overlay;
		},
		async write(overlay) {
			if (!overlay) {
				await idbDelete("board_play_saves", key);
				return;
			}
			const now = Date.now();
			await idbPut<BoardPlaySaveCacheRecord>("board_play_saves", {
				key,
				userKey,
				...ref,
				overlay,
				updatedAt: now,
				lastAccessedAt: now,
			});
		},
	};
}
