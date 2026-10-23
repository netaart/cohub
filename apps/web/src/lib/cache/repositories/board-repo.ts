import {
	type BoardManifestCacheRecord,
	idbDelete,
	idbGet,
	idbPut,
} from "$lib/cache/db";
import {
	boardManifestKey,
	canUseUserScopedCache,
	getCacheUserKey,
} from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";

const manifests = new MemoryLru<string, string>(512);

export async function readBoardManifestCache(input: {
	spaceId: string;
	sourceKey: string;
	path: string;
}) {
	const userKey = getCacheUserKey();
	const key = boardManifestKey(
		userKey,
		input.spaceId,
		input.sourceKey,
		input.path,
	);
	const remembered = manifests.get(key);
	if (remembered) return remembered;
	if (!canUseUserScopedCache(userKey)) return null;
	const record = await idbGet<BoardManifestCacheRecord>("board_manifests", key);
	if (record) manifests.set(key, record.boardId);
	return record?.boardId ?? null;
}

export async function writeBoardManifestCache(input: {
	spaceId: string;
	sourceKey: string;
	path: string;
	boardId: string | null;
}) {
	const userKey = getCacheUserKey();
	const key = boardManifestKey(
		userKey,
		input.spaceId,
		input.sourceKey,
		input.path,
	);
	if (!input.boardId) {
		manifests.delete(key);
		if (canUseUserScopedCache(userKey)) await idbDelete("board_manifests", key);
		return;
	}
	if (manifests.get(key) === input.boardId) return;
	manifests.set(key, input.boardId);
	if (!canUseUserScopedCache(userKey)) return;
	await idbPut<BoardManifestCacheRecord>("board_manifests", {
		key,
		userKey,
		spaceId: input.spaceId,
		sourceKey: input.sourceKey,
		path: input.path,
		boardId: input.boardId,
		lastAccessedAt: Date.now(),
	});
}
