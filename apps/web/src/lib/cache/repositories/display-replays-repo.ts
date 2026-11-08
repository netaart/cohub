import { type DisplayReplayCacheRecord, idbGet, idbPut } from "$lib/cache/db";
import {
	canUseUserScopedCache,
	encodeKeyPart,
	getCacheUserKeyAsync,
} from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";

const STORE = "display_replays";
const memory = new MemoryLru<string, DisplayReplayCacheRecord>(64);

function keyOf(userKey: string, spaceId: string, scope: string) {
	return [userKey, spaceId, scope].map(encodeKeyPart).join(":");
}

export const displayReplaysRepo = {
	async get<T>(spaceId: string, scope: string): Promise<T | null> {
		const userKey = await getCacheUserKeyAsync();
		if (!canUseUserScopedCache(userKey)) return null;
		const key = keyOf(userKey, spaceId, scope);
		const record =
			memory.get(key) ??
			(await idbGet<DisplayReplayCacheRecord>(STORE, key).catch(() => null));
		if (!record) return null;
		memory.set(key, record);
		return record.value as T;
	},

	async set(spaceId: string, scope: string, value: unknown) {
		const userKey = await getCacheUserKeyAsync();
		if (!canUseUserScopedCache(userKey)) return;
		const now = Date.now();
		const record: DisplayReplayCacheRecord = {
			key: keyOf(userKey, spaceId, scope),
			userKey,
			spaceId,
			value,
			updatedAt: now,
			lastAccessedAt: now,
		};
		memory.set(record.key, record);
		await idbPut(STORE, record).catch(() => undefined);
	},
};
