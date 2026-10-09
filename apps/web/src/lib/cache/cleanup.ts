import {
	idbDeleteWhere,
	idbGetAll,
	type LabelItemsCacheRecord,
	type LabelTreeCacheRecord,
	type ResourceLabelsCacheRecord,
	type SessionDetailCacheRecord,
	type SessionListCacheRecord,
	type SessionListIndexCacheRecord,
	type SessionTurnsCacheRecord,
	type SpaceFsDirCacheRecord,
} from "$lib/cache/db";
import { getCacheUserKey } from "$lib/cache/keys";
import type { ActivityCacheRecord } from "$lib/cache/repositories/activity-repo";

const CLEANUP_STORAGE_KEY = "cohub:cache:last-cleanup-at:v1";
const LEGACY_ACTIVITY_PREFIX = "cohub:activity:v1:";
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MAX_ENTRIES = {
	sessionLists: 0,
	sessionListIndexes: 500,
	sessionDetails: 5000,
	sessionTurns: 1000,
	spaceFsDirs: 5000,
	labelTrees: 500,
	labelItems: 5000,
	resourceLabels: 5000,
	activity: 30,
};

function shouldRunCleanup() {
	if (typeof window === "undefined") return false;
	try {
		const last = Number(window.localStorage.getItem(CLEANUP_STORAGE_KEY) ?? 0);
		return !Number.isFinite(last) || Date.now() - last > CLEANUP_INTERVAL_MS;
	} catch {
		return true;
	}
}

function markCleanupDone() {
	try {
		window.localStorage.setItem(CLEANUP_STORAGE_KEY, String(Date.now()));
	} catch {
		// ignore
	}
}

async function cleanupStore<
	T extends { key: string; userKey: string; lastAccessedAt: number },
>(
	store:
		| "session_lists"
		| "session_list_indexes"
		| "session_details"
		| "session_turns"
		| "space_fs_dirs"
		| "label_trees"
		| "label_items"
		| "resource_labels"
		| "activity",
	maxEntries: number,
) {
	const userKey = getCacheUserKey();
	const records = await idbGetAll<T>(store);
	const mine = records
		.filter((record) => record.userKey === userKey)
		.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
	const deleteCount = Math.max(0, mine.length - maxEntries);
	if (deleteCount === 0) return;
	const keysToDelete = new Set(
		mine.slice(0, deleteCount).map((record) => record.key),
	);
	await idbDeleteWhere<T & { key: string }>(store, (record) =>
		keysToDelete.has(record.key),
	);
}

export function removeLegacyLocalStorage() {
	try {
		for (let index = localStorage.length - 1; index >= 0; index -= 1) {
			const key = localStorage.key(index);
			if (key?.startsWith(LEGACY_ACTIVITY_PREFIX)) localStorage.removeItem(key);
		}
	} catch {
		// ignore
	}
}

export function scheduleCacheCleanup() {
	if (typeof window === "undefined" || typeof indexedDB === "undefined") return;
	if (!shouldRunCleanup()) return;
	window.setTimeout(() => {
		removeLegacyLocalStorage();
		void Promise.all([
			cleanupStore<SessionListCacheRecord>(
				"session_lists",
				MAX_ENTRIES.sessionLists,
			),
			cleanupStore<SessionListIndexCacheRecord>(
				"session_list_indexes",
				MAX_ENTRIES.sessionListIndexes,
			),
			cleanupStore<SessionDetailCacheRecord>(
				"session_details",
				MAX_ENTRIES.sessionDetails,
			),
			cleanupStore<SessionTurnsCacheRecord>(
				"session_turns",
				MAX_ENTRIES.sessionTurns,
			),
			cleanupStore<SpaceFsDirCacheRecord>(
				"space_fs_dirs",
				MAX_ENTRIES.spaceFsDirs,
			),
			cleanupStore<LabelTreeCacheRecord>("label_trees", MAX_ENTRIES.labelTrees),
			cleanupStore<LabelItemsCacheRecord>(
				"label_items",
				MAX_ENTRIES.labelItems,
			),
			cleanupStore<ResourceLabelsCacheRecord>(
				"resource_labels",
				MAX_ENTRIES.resourceLabels,
			),
			cleanupStore<ActivityCacheRecord>("activity", MAX_ENTRIES.activity),
		])
			.then(markCleanupDone)
			.catch(() => undefined);
	}, 5000);
}
