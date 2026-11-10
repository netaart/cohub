import type { SpaceRecord } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "$lib/cache/broadcast";
import {
	idbDelete,
	idbGet,
	idbGetAllByIndex,
	idbPut,
	type SpaceRecordCacheRecord,
} from "$lib/cache/db";
import { getCacheUserKey, spaceRecordKey } from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";
import type { CacheSource } from "$lib/cache/types";

const SPACE_RECORD_TTL_MS = 30_000;
const memory = new MemoryLru<string, SpaceRecordCacheRecord>(50);
const listeners = new Set<
	(snapshot: SpaceRecordSnapshot & { spaceId: string }) => void
>();
let subscribedToBroadcast = false;

export type SpaceRecordSnapshot = {
	space: SpaceRecord;
	updatedAt: number;
	stale: boolean;
	source: CacheSource;
};

function toSnapshot(
	record: SpaceRecordCacheRecord,
	source: CacheSource,
): SpaceRecordSnapshot {
	return {
		space: record.space,
		updatedAt: record.updatedAt,
		stale: Date.now() - record.updatedAt >= SPACE_RECORD_TTL_MS,
		source,
	};
}

async function readRecord(spaceId: string) {
	const userKey = getCacheUserKey();
	const key = spaceRecordKey(userKey, spaceId);
	const cached = memory.get(key);
	if (cached) return { record: cached, source: "memory" as CacheSource };
	const record = await idbGet<SpaceRecordCacheRecord>("space_records", key);
	if (!record) return null;
	const touched = { ...record, lastAccessedAt: Date.now() };
	memory.set(key, touched);
	void idbPut("space_records", touched).catch(() => undefined);
	return { record: touched, source: "indexeddb" as CacheSource };
}

async function writeRecord(
	spaceId: string,
	space: SpaceRecord,
	options?: { broadcast?: boolean; source?: CacheSource },
) {
	const userKey = getCacheUserKey();
	const key = spaceRecordKey(userKey, spaceId);
	const now = Date.now();
	const record: SpaceRecordCacheRecord = {
		key,
		userKey,
		spaceId,
		space,
		updatedAt: now,
		lastAccessedAt: now,
		watermark: space.lastActivityAt ?? space.updatedAt ?? null,
	};
	memory.set(key, record);
	await idbPut("space_records", record);
	if (options?.broadcast !== false) {
		publishCacheMessage({
			type: "cache-updated",
			store: "space_records",
			key,
			userKey,
			spaceId,
			updatedAt: now,
		});
	}
	emit(spaceId, toSnapshot(record, options?.source ?? "indexeddb"));
	return record;
}

function emit(spaceId: string, snapshot: SpaceRecordSnapshot) {
	for (const listener of listeners) listener({ ...snapshot, spaceId });
}

function ensureBroadcastSubscription() {
	if (subscribedToBroadcast) return;
	subscribedToBroadcast = true;
	subscribeCacheMessages((message) => {
		if (message.store !== "space_records" || !message.spaceId) return;
		if (message.userKey !== getCacheUserKey()) return;
		if (message.key) memory.delete(message.key);
		if (message.type === "cache-deleted") return;
		void readRecord(message.spaceId).then((result) => {
			if (result)
				emit(message.spaceId as string, toSnapshot(result.record, "indexeddb"));
		});
	});
}

export const spaceRecordRepo = {
	async getCached(spaceId: string) {
		ensureBroadcastSubscription();
		const result = await readRecord(spaceId);
		return result ? toSnapshot(result.record, result.source) : null;
	},

	async set(
		spaceId: string,
		space: SpaceRecord,
		options?: { source?: CacheSource },
	) {
		ensureBroadcastSubscription();
		const record = await writeRecord(spaceId, space, {
			source: options?.source ?? "network",
		});
		return toSnapshot(record, options?.source ?? "network");
	},

	/** Every cached Space record of the current user, oldest update first. */
	async listCached(): Promise<SpaceRecord[]> {
		const userKey = getCacheUserKey();
		const records = await idbGetAllByIndex<SpaceRecordCacheRecord>(
			"space_records",
			"by_user_space",
			IDBKeyRange.bound([userKey], [userKey, []]),
		);
		return records
			.sort((a, b) => a.updatedAt - b.updatedAt)
			.map((record) => record.space);
	},

	async delete(spaceId: string) {
		const userKey = getCacheUserKey();
		const key = spaceRecordKey(userKey, spaceId);
		memory.delete(key);
		await idbDelete("space_records", key);
		publishCacheMessage({
			type: "cache-deleted",
			store: "space_records",
			key,
			userKey,
			spaceId,
			updatedAt: Date.now(),
		});
	},

	subscribe(spaceId: string, handler: (snapshot: SpaceRecordSnapshot) => void) {
		ensureBroadcastSubscription();
		const listener = (snapshot: SpaceRecordSnapshot & { spaceId: string }) => {
			if (snapshot.spaceId === spaceId) handler(snapshot);
		};
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};
