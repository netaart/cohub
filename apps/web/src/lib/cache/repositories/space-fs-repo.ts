import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";
import type { SpaceFsEntry } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "$lib/cache/broadcast";
import {
	idbGet,
	idbRunTransaction,
	type SpaceFsDirCacheRecord,
	type SpaceFsEpochCacheRecord,
} from "$lib/cache/db";
import {
	getCacheUserKey,
	normalizeDirPath,
	spaceFsDirKey,
	spaceFsEpochKey,
} from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";
import { getFsInvalidationTargets } from "$lib/cache/space-fs-invalidation";
import type { CacheSource } from "$lib/cache/types";

const SPACE_FS_TTL_MS = 60_000;
const memory = new MemoryLru<string, SpaceFsDirCacheRecord>(300);
const epochs = new Map<string, number>();
const listeners = new Set<
	(snapshot: SpaceFsDirSnapshot & { spaceId: string; dirPath: string }) => void
>();
let subscribedToBroadcast = false;

export type SpaceFsDirSnapshot = {
	dirPath: string;
	entries: SpaceFsEntry[];
	updatedAt: number;
	stale: boolean;
	source: CacheSource;
};

export type SpaceFsDirCommit = {
	committed: boolean;
	snapshot: SpaceFsDirSnapshot | null;
};

function sortEntries(entries: SpaceFsEntry[]) {
	return [...entries].sort((a, b) => {
		if (a.type === "dir" && b.type !== "dir") return -1;
		if (a.type !== "dir" && b.type === "dir") return 1;
		return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	});
}

function normalizeEntries(entries: SpaceFsEntry[]) {
	const byPath = new Map<string, SpaceFsEntry>();
	for (const entry of entries) byPath.set(normalizeDirPath(entry.path), entry);
	return sortEntries(Array.from(byPath.values()));
}

function toSnapshot(
	record: SpaceFsDirCacheRecord,
	source: CacheSource,
): SpaceFsDirSnapshot {
	return {
		dirPath: record.dirPath,
		entries: record.entries,
		updatedAt: record.updatedAt,
		stale: Date.now() - record.updatedAt >= SPACE_FS_TTL_MS,
		source,
	};
}

function createRecord(
	userKey: string,
	spaceId: string,
	dirPath: string,
	entries: SpaceFsEntry[],
): SpaceFsDirCacheRecord {
	const normalizedDir = normalizeDirPath(dirPath);
	const normalized = normalizeEntries(entries);
	const now = Date.now();
	return {
		key: spaceFsDirKey(userKey, spaceId, normalizedDir),
		userKey,
		spaceId,
		dirPath: normalizedDir,
		entries: normalized,
		updatedAt: now,
		lastAccessedAt: now,
		watermark:
			normalized
				.reduce<number | null>(
					(max, entry) =>
						max == null ? entry.mtimeMs : Math.max(max, entry.mtimeMs),
					null,
				)
				?.toString() ?? null,
	};
}

function requestValue<T>(request: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function deleteIndexRange(
	store: IDBObjectStore,
	indexName: string,
	range: IDBKeyRange,
) {
	return new Promise<void>((resolve, reject) => {
		const request = store.index(indexName).openKeyCursor(range);
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve();
				return;
			}
			store.delete(cursor.primaryKey);
			cursor.continue();
		};
		request.onerror = () => reject(request.error);
	});
}

async function deleteMatchingRecords(
	store: IDBObjectStore,
	userKey: string,
	spaceId: string,
	dirs: Set<string>,
	subtrees: Set<string>,
) {
	if (subtrees.has(""))
		return deleteIndexRange(
			store,
			"by_user_space",
			IDBKeyRange.only([userKey, spaceId]),
		);
	for (const dir of dirs) store.delete(spaceFsDirKey(userKey, spaceId, dir));
	await Promise.all(
		Array.from(subtrees, (prefix) => {
			store.delete(spaceFsDirKey(userKey, spaceId, prefix));
			// Every dirPath below `prefix/` sorts within [`prefix/`, `prefix0`).
			return deleteIndexRange(
				store,
				"by_user_space_dir",
				IDBKeyRange.bound(
					[userKey, spaceId, `${prefix}/`],
					[userKey, spaceId, `${prefix}0`],
					false,
					true,
				),
			);
		}),
	);
}

async function readRecord(spaceId: string, dirPath: string) {
	const userKey = getCacheUserKey();
	const normalizedDir = normalizeDirPath(dirPath);
	const key = spaceFsDirKey(userKey, spaceId, normalizedDir);
	const cached = memory.get(key);
	if (cached) return { record: cached, source: "memory" as CacheSource };
	const record = await idbGet<SpaceFsDirCacheRecord>("space_fs_dirs", key);
	if (!record) return null;
	const touched = { ...record, lastAccessedAt: Date.now() };
	memory.set(key, touched);
	return { record: touched, source: "indexeddb" as CacheSource };
}

async function readEpoch(spaceId: string) {
	const userKey = getCacheUserKey();
	const key = spaceFsEpochKey(userKey, spaceId);
	const cached = epochs.get(key);
	if (cached != null) return cached;
	const record = await idbGet<SpaceFsEpochCacheRecord>("space_fs_epochs", key);
	cacheEpoch(userKey, spaceId, record?.epoch ?? 0);
	return epochs.get(key) ?? 0;
}

function cacheEpoch(userKey: string, spaceId: string, epoch: number) {
	const key = spaceFsEpochKey(userKey, spaceId);
	epochs.set(key, Math.max(epochs.get(key) ?? 0, epoch));
}

function publishInvalidation(userKey: string, spaceId: string, epoch: number) {
	cacheEpoch(userKey, spaceId, epoch);
	memory.clear();
	publishCacheMessage({
		type: "cache-scope-invalidated",
		store: "space_fs_dirs",
		userKey,
		spaceId,
		prefix: "",
		epoch,
		updatedAt: Date.now(),
	});
}

function emit(spaceId: string, dirPath: string, snapshot: SpaceFsDirSnapshot) {
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent("cohub:space-fs-dir-cache-updated", {
				detail: { spaceId, dirPath, entries: snapshot.entries },
			}),
		);
	}
	for (const listener of listeners) listener({ ...snapshot, spaceId, dirPath });
}

function publishRecord(
	record: SpaceFsDirCacheRecord,
	epoch: number,
	source: CacheSource,
) {
	memory.set(record.key, record);
	cacheEpoch(record.userKey, record.spaceId, epoch);
	publishCacheMessage({
		type: "cache-updated",
		store: "space_fs_dirs",
		key: record.key,
		userKey: record.userKey,
		spaceId: record.spaceId,
		dirPath: record.dirPath,
		epoch,
		updatedAt: record.updatedAt,
	});
	const snapshot = toSnapshot(record, source);
	emit(record.spaceId, record.dirPath, snapshot);
	return snapshot;
}

function ensureBroadcastSubscription() {
	if (subscribedToBroadcast) return;
	subscribedToBroadcast = true;
	subscribeCacheMessages((message) => {
		if (message.store !== "space_fs_dirs" || !message.spaceId) return;
		if (message.userKey !== getCacheUserKey()) return;
		if (message.epoch != null)
			cacheEpoch(message.userKey, message.spaceId, message.epoch);
		if (message.key) memory.delete(message.key);
		if (message.type === "cache-scope-invalidated") {
			memory.clear();
			return;
		}
		if (!message.dirPath) return;
		if (message.type === "cache-deleted") {
			emit(message.spaceId, message.dirPath, {
				dirPath: message.dirPath,
				entries: [],
				updatedAt: message.updatedAt,
				stale: true,
				source: "indexeddb",
			});
			return;
		}
		void readRecord(message.spaceId, message.dirPath).then((result) => {
			if (result)
				emit(
					message.spaceId as string,
					message.dirPath as string,
					toSnapshot(result.record, "indexeddb"),
				);
		});
	});
}

type PendingInvalidation = {
	dirs: Set<string>;
	subtrees: Set<string>;
	epoch: Promise<number>;
};

const pendingInvalidations = new Map<string, PendingInvalidation>();
const invalidationTails = new Map<string, Promise<unknown>>();

// Targets queued while a transaction runs merge into the next one, in order.
function invalidateRecords(
	spaceId: string,
	dirs: Set<string>,
	subtrees: Set<string>,
): Promise<number> {
	if (dirs.size === 0 && subtrees.size === 0) return readEpoch(spaceId);
	const userKey = getCacheUserKey();
	const laneKey = spaceFsEpochKey(userKey, spaceId);
	const pending = pendingInvalidations.get(laneKey);
	if (pending) {
		for (const dir of dirs) pending.dirs.add(dir);
		for (const subtree of subtrees) pending.subtrees.add(subtree);
		return pending.epoch;
	}
	const previous = invalidationTails.get(laneKey) ?? Promise.resolve();
	const batch: PendingInvalidation = {
		dirs: new Set(dirs),
		subtrees: new Set(subtrees),
		epoch: previous.then(() => {
			pendingInvalidations.delete(laneKey);
			return commitInvalidation(userKey, spaceId, batch.dirs, batch.subtrees);
		}),
	};
	pendingInvalidations.set(laneKey, batch);
	const tail = batch.epoch.catch(() => undefined);
	invalidationTails.set(laneKey, tail);
	void tail.then(() => {
		if (invalidationTails.get(laneKey) === tail)
			invalidationTails.delete(laneKey);
	});
	return batch.epoch;
}

async function commitInvalidation(
	userKey: string,
	spaceId: string,
	dirs: Set<string>,
	subtrees: Set<string>,
) {
	ensureBroadcastSubscription();
	const epochKey = spaceFsEpochKey(userKey, spaceId);
	const fallbackEpoch = (epochs.get(epochKey) ?? 0) + 1;
	const result = await idbRunTransaction(
		["space_fs_dirs", "space_fs_epochs"],
		"readwrite",
		async (getStore) => {
			const epochStore = getStore("space_fs_epochs");
			const current = (await requestValue(epochStore.get(epochKey))) as
				| SpaceFsEpochCacheRecord
				| undefined;
			const epoch = Math.max(current?.epoch ?? 0, fallbackEpoch - 1) + 1;
			epochStore.put({
				key: epochKey,
				userKey,
				spaceId,
				epoch,
				updatedAt: Date.now(),
			} satisfies SpaceFsEpochCacheRecord);
			await deleteMatchingRecords(
				getStore("space_fs_dirs"),
				userKey,
				spaceId,
				dirs,
				subtrees,
			);
			return epoch;
		},
	);
	const epoch = result ?? fallbackEpoch;
	publishInvalidation(userKey, spaceId, epoch);
	return epoch;
}

async function patchRecord(
	spaceId: string,
	dirPath: string,
	updater: (entries: SpaceFsEntry[]) => SpaceFsEntry[],
) {
	ensureBroadcastSubscription();
	const userKey = getCacheUserKey();
	const normalizedDir = normalizeDirPath(dirPath);
	const key = spaceFsDirKey(userKey, spaceId, normalizedDir);
	const epochKey = spaceFsEpochKey(userKey, spaceId);
	const fallbackEpoch = (epochs.get(epochKey) ?? 0) + 1;
	const result = await idbRunTransaction(
		["space_fs_dirs", "space_fs_epochs"],
		"readwrite",
		async (getStore) => {
			const dirStore = getStore("space_fs_dirs");
			const epochStore = getStore("space_fs_epochs");
			const [currentRecord, currentEpoch] = await Promise.all([
				requestValue(dirStore.get(key)) as Promise<
					SpaceFsDirCacheRecord | undefined
				>,
				requestValue(epochStore.get(epochKey)) as Promise<
					SpaceFsEpochCacheRecord | undefined
				>,
			]);
			const epoch = Math.max(currentEpoch?.epoch ?? 0, fallbackEpoch - 1) + 1;
			const record = currentRecord
				? createRecord(
						userKey,
						spaceId,
						normalizedDir,
						updater(currentRecord.entries),
					)
				: null;
			if (record) dirStore.put(record);
			epochStore.put({
				key: epochKey,
				userKey,
				spaceId,
				epoch,
				updatedAt: Date.now(),
			} satisfies SpaceFsEpochCacheRecord);
			return { epoch, record };
		},
	);
	if (result) {
		if (result.record)
			return publishRecord(result.record, result.epoch, "indexeddb");
		publishInvalidation(userKey, spaceId, result.epoch);
		return null;
	}
	const current = memory.get(key);
	if (!current) {
		publishInvalidation(userKey, spaceId, fallbackEpoch);
		return null;
	}
	const record = createRecord(
		userKey,
		spaceId,
		normalizedDir,
		updater(current.entries),
	);
	return publishRecord(record, fallbackEpoch, "indexeddb");
}

export const spaceFsRepo = {
	async getDir(spaceId: string, dirPath: string) {
		ensureBroadcastSubscription();
		const result = await readRecord(spaceId, dirPath);
		return result ? toSnapshot(result.record, result.source) : null;
	},

	getEpoch(spaceId: string) {
		ensureBroadcastSubscription();
		return readEpoch(spaceId);
	},

	async setDirIfEpoch(
		spaceId: string,
		dirPath: string,
		entries: SpaceFsEntry[],
		expectedEpoch: number,
	): Promise<SpaceFsDirCommit> {
		ensureBroadcastSubscription();
		const userKey = getCacheUserKey();
		const normalizedDir = normalizeDirPath(dirPath);
		const epochKey = spaceFsEpochKey(userKey, spaceId);
		const record = createRecord(userKey, spaceId, normalizedDir, entries);
		const result = await idbRunTransaction(
			["space_fs_dirs", "space_fs_epochs"],
			"readwrite",
			async (getStore) => {
				const epochStore = getStore("space_fs_epochs");
				const epochRecord = (await requestValue(epochStore.get(epochKey))) as
					| SpaceFsEpochCacheRecord
					| undefined;
				const persistedEpoch = epochRecord?.epoch ?? 0;
				const epoch = Math.max(persistedEpoch, epochs.get(epochKey) ?? 0);
				if (epoch !== expectedEpoch)
					return { committed: false as const, epoch, record: null };
				getStore("space_fs_dirs").put(record);
				if (persistedEpoch !== epoch) {
					epochStore.put({
						key: epochKey,
						userKey,
						spaceId,
						epoch,
						updatedAt: Date.now(),
					} satisfies SpaceFsEpochCacheRecord);
				}
				return { committed: true as const, epoch, record };
			},
		);
		if (!result) {
			const epoch = epochs.get(epochKey) ?? expectedEpoch;
			if (epoch !== expectedEpoch) return { committed: false, snapshot: null };
			return {
				committed: true,
				snapshot: publishRecord(record, epoch, "network"),
			};
		}
		cacheEpoch(userKey, spaceId, result.epoch);
		if (!result.committed) return { committed: false, snapshot: null };
		return {
			committed: true,
			snapshot: publishRecord(result.record, result.epoch, "network"),
		};
	},

	patchDir(
		spaceId: string,
		dirPath: string,
		updater: (entries: SpaceFsEntry[]) => SpaceFsEntry[],
	) {
		return patchRecord(spaceId, dirPath, updater);
	},

	async clearDir(spaceId: string, dirPath: string) {
		await invalidateRecords(
			spaceId,
			new Set([normalizeDirPath(dirPath)]),
			new Set(),
		);
	},

	async clearSubtree(spaceId: string, dirPath: string) {
		await invalidateRecords(
			spaceId,
			new Set(),
			new Set([normalizeDirPath(dirPath)]),
		);
	},

	async invalidateFsChanged(spaceId: string, payload: SpaceFsChangedPayload) {
		const targets = getFsInvalidationTargets(payload);
		await invalidateRecords(spaceId, targets.dirs, targets.subtrees);
		return { refreshDirs: targets.dirs };
	},

	subscribeDir(
		spaceId: string,
		dirPath: string,
		handler: (snapshot: SpaceFsDirSnapshot) => void,
	) {
		ensureBroadcastSubscription();
		const normalizedDir = normalizeDirPath(dirPath);
		const listener = (
			snapshot: SpaceFsDirSnapshot & { spaceId: string; dirPath: string },
		) => {
			if (snapshot.spaceId === spaceId && snapshot.dirPath === normalizedDir)
				handler(snapshot);
		};
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};
