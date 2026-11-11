import {
	type BoardAssetSource,
	type BoardDocument,
	parseBoardDocument,
} from "@neta-art/cohub/board";
import { sdk } from "$lib/sdk";

const MAX_CACHED = 16;
const cache = new Map<string, Promise<BoardDocument>>();

/** A checkpoint's Board never changes, so one fetch serves every later open. */
export function loadCheckpointBoard(input: {
	spaceId: string;
	checkpointId: string;
	boardId: string;
}): Promise<BoardDocument> {
	const key = `${input.spaceId}:${input.checkpointId}:${input.boardId}`;
	let pending = cache.get(key);
	if (pending) {
		cache.delete(key);
		cache.set(key, pending);
		return pending;
	}
	pending = sdk
		.space(input.spaceId)
		.checkpoints(input.checkpointId)
		.board(input.boardId)
		.then((saved) => {
			const parsed = parseBoardDocument(saved, { keepUnknown: true });
			if (!parsed.ok) throw new Error("Saved Board document is invalid.");
			return parsed.document;
		});
	pending.catch(() => cache.delete(key));
	cache.set(key, pending);
	if (cache.size > MAX_CACHED)
		cache.delete(cache.keys().next().value as string);
	return pending;
}

/** Media resolves from the checkpoint too, so the Board shows what was saved. */
export function checkpointBoardAssetSource(
	spaceId: string,
	checkpointId: string,
): BoardAssetSource {
	const files = sdk.space(spaceId).checkpoints(checkpointId).files;
	return { resolveFile: (path, options) => files.resolve(path, options) };
}
