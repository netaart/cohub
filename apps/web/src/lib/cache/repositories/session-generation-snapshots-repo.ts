import type { SessionGenerationSnapshotCacheRecord } from "$lib/cache/db";
import { idbDelete, idbDeleteWhere, idbGet, idbPut } from "$lib/cache/db";
import { getCacheUserKey, sessionGenerationSnapshotKey } from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";

const SNAPSHOT_TTL_MS = 2 * 60 * 60 * 1000;
const memory = new MemoryLru<string, SessionGenerationSnapshotCacheRecord>(16);

export type SessionGenerationSnapshotInput = Omit<
	SessionGenerationSnapshotCacheRecord,
	"key" | "userKey" | "createdAt" | "updatedAt" | "expiresAt"
> & {
	createdAt?: number | null;
	updatedAt?: number | null;
	expiresAt?: number | null;
};

function getKey(spaceId: string, sessionId: string) {
	return sessionGenerationSnapshotKey(getCacheUserKey(), spaceId, sessionId);
}

function isExpired(record: SessionGenerationSnapshotCacheRecord) {
	return record.expiresAt <= Date.now();
}

export const sessionGenerationSnapshotsRepo = {
	async get(spaceId: string, sessionId: string) {
		const userKey = getCacheUserKey();
		const key = getKey(spaceId, sessionId);
		const record =
			memory.get(key) ??
			(await idbGet<SessionGenerationSnapshotCacheRecord>(
				"session_generation_snapshots",
				key,
			));
		if (!record || getCacheUserKey() !== userKey || record.userKey !== userKey)
			return null;
		if (isExpired(record)) {
			memory.delete(key);
			void idbDelete("session_generation_snapshots", key).catch(
				() => undefined,
			);
			return null;
		}
		memory.set(key, record);
		return record;
	},

	async put(input: SessionGenerationSnapshotInput) {
		const userKey = getCacheUserKey();
		const now = Date.now();
		const record: SessionGenerationSnapshotCacheRecord = {
			...input,
			key: sessionGenerationSnapshotKey(
				userKey,
				input.spaceId,
				input.sessionId,
			),
			userKey,
			createdAt: input.createdAt ?? now,
			updatedAt: input.updatedAt ?? now,
			expiresAt: input.expiresAt ?? now + SNAPSHOT_TTL_MS,
		};
		memory.set(record.key, record);
		await idbPut("session_generation_snapshots", record);
		return record;
	},

	async delete(spaceId: string, sessionId: string) {
		const key = getKey(spaceId, sessionId);
		memory.delete(key);
		await idbDelete("session_generation_snapshots", key);
	},

	async deleteExpired() {
		const now = Date.now();
		const userKey = getCacheUserKey();
		await idbDeleteWhere<SessionGenerationSnapshotCacheRecord>(
			"session_generation_snapshots",
			(record) => record.userKey === userKey && record.expiresAt <= now,
		);
	},
};
