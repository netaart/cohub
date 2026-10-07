import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "$lib/cache/broadcast";
import { idbGet, idbPut, type StoreName } from "$lib/cache/db";
import {
	canUseUserScopedCache,
	encodeKeyPart,
	getCacheUserKey,
	getCacheUserKeyAsync,
} from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";

export type ActivityCacheRecord<T = unknown> = {
	key: string;
	userKey: string;
	scope: string;
	days: number;
	activity: T;
	updatedAt: number;
	lastAccessedAt: number;
};

export type ActivitySnapshot<T> = {
	activity: T;
	updatedAt: number;
};

export const USER_ACTIVITY_SCOPE = "me";

const TTL_MS = 30 * 60 * 1000;
const MEMORY_LIMIT = 24;
const STORE: StoreName = "activity";
const memory = new MemoryLru<string, ActivityCacheRecord>(MEMORY_LIMIT);
let subscribed = false;

function activityKey(userKey: string, scope: string, days: number) {
	return [userKey, scope, String(days)].map(encodeKeyPart).join(":");
}

function toSnapshot<T>(record: ActivityCacheRecord): ActivitySnapshot<T> {
	return { activity: record.activity as T, updatedAt: record.updatedAt };
}

function ensureBroadcastSubscription() {
	if (subscribed) return;
	subscribed = true;
	subscribeCacheMessages((message) => {
		if (message.store !== STORE || !message.key) return;
		if (message.userKey !== getCacheUserKey()) return;
		memory.delete(message.key);
	});
}

export const activityRepo = {
	async getCached<T>(
		scope: string,
		days: number,
	): Promise<ActivitySnapshot<T> | null> {
		const userKey = await getCacheUserKeyAsync();
		if (!canUseUserScopedCache(userKey)) return null;
		ensureBroadcastSubscription();
		const key = activityKey(userKey, scope, days);
		const cached = memory.get(key);
		if (cached) return toSnapshot<T>(cached);
		const record = await idbGet<ActivityCacheRecord>(STORE, key);
		if (!record) return null;
		memory.set(key, record);
		return toSnapshot<T>(record);
	},

	async set<T>(
		scope: string,
		days: number,
		activity: T,
	): Promise<ActivitySnapshot<T>> {
		const userKey = await getCacheUserKeyAsync();
		const now = Date.now();
		if (!canUseUserScopedCache(userKey)) return { activity, updatedAt: now };
		ensureBroadcastSubscription();
		const key = activityKey(userKey, scope, days);
		const record: ActivityCacheRecord<T> = {
			key,
			userKey,
			scope,
			days,
			activity,
			updatedAt: now,
			lastAccessedAt: now,
		};
		memory.set(key, record);
		await idbPut(STORE, record).catch(() => undefined);
		publishCacheMessage({
			type: "cache-updated",
			store: STORE,
			key,
			userKey,
			updatedAt: now,
		});
		return toSnapshot<T>(record);
	},

	isFresh(snapshot: ActivitySnapshot<unknown>) {
		return Date.now() - snapshot.updatedAt < TTL_MS;
	},
};
