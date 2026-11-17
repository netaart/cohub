import type { LabelListItem } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "#lib/cache/broadcast.ts";
import {
	idbDelete,
	idbGet,
	idbPut,
	type LabelTreeCacheRecord,
} from "#lib/cache/db.ts";
import { getCacheUserKey, labelTreeKey } from "#lib/cache/keys.ts";
import { MemoryLru } from "#lib/cache/memory-lru.ts";
import type { CacheSource } from "#lib/cache/types.ts";

const LABEL_TREE_TTL_MS = 30_000;
const memory = new MemoryLru<string, LabelTreeCacheRecord>(50);
const listeners = new Set<
	(snapshot: LabelTreeSnapshot & { spaceId: string }) => void
>();
let subscribedToBroadcast = false;

export type LabelTreeSnapshot = {
	labels: LabelListItem[];
	updatedAt: number;
	stale: boolean;
	source: CacheSource;
};

function normalizeLabels(labels: LabelListItem[]) {
	return Array.isArray(labels) ? labels : [];
}

function getLabelTreeWatermark(labels: LabelListItem[]) {
	let watermark: string | null = null;
	const visit = (items: LabelListItem[]) => {
		for (const label of items) {
			if (label.updatedAt && (!watermark || label.updatedAt > watermark)) {
				watermark = label.updatedAt;
			}
			if (label.children?.length) visit(label.children);
		}
	};
	visit(labels);
	return watermark;
}

function toSnapshot(
	record: LabelTreeCacheRecord,
	source: CacheSource,
): LabelTreeSnapshot {
	return {
		labels: record.labels,
		updatedAt: record.updatedAt,
		stale: Date.now() - record.updatedAt >= LABEL_TREE_TTL_MS,
		source,
	};
}

async function readRecord(spaceId: string) {
	const userKey = getCacheUserKey();
	const key = labelTreeKey(userKey, spaceId);
	const cached = memory.get(key);
	if (cached) return { record: cached, source: "memory" as CacheSource };
	const record = await idbGet<LabelTreeCacheRecord>("label_trees", key);
	if (!record) return null;
	const touched = { ...record, lastAccessedAt: Date.now() };
	memory.set(key, touched);
	void idbPut("label_trees", touched).catch(() => undefined);
	return { record: touched, source: "indexeddb" as CacheSource };
}

async function writeRecord(
	spaceId: string,
	labels: LabelListItem[],
	options?: { broadcast?: boolean; source?: CacheSource },
) {
	const userKey = getCacheUserKey();
	const key = labelTreeKey(userKey, spaceId);
	const now = Date.now();
	const normalized = normalizeLabels(labels);
	const record: LabelTreeCacheRecord = {
		key,
		userKey,
		spaceId,
		labels: normalized,
		updatedAt: now,
		lastAccessedAt: now,
		watermark: getLabelTreeWatermark(normalized),
	};
	memory.set(key, record);
	// Label trees are small and drive first-paint sidebar hydration. Await the put
	// (with IDB timeout) so a quick refresh still hits warm cache. Large label
	// item / session payloads stay fire-and-forget elsewhere.
	try {
		await idbPut("label_trees", record);
	} catch (error) {
		console.warn("[label-tree] Failed to persist", { spaceId, error });
	}
	if (options?.broadcast !== false) {
		publishCacheMessage({
			type: "cache-updated",
			store: "label_trees",
			key,
			userKey,
			spaceId,
			updatedAt: now,
		});
	}
	emit(spaceId, toSnapshot(record, options?.source ?? "indexeddb"));
	return record;
}

function emit(spaceId: string, snapshot: LabelTreeSnapshot) {
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent("cohub:space-labels-updated", {
				detail: { spaceId, labels: snapshot.labels },
			}),
		);
	}
	for (const listener of listeners) listener({ ...snapshot, spaceId });
}

function ensureBroadcastSubscription() {
	if (subscribedToBroadcast) return;
	subscribedToBroadcast = true;
	subscribeCacheMessages((message) => {
		if (message.store !== "label_trees" || !message.spaceId) return;
		if (message.userKey !== getCacheUserKey()) return;
		if (message.key) memory.delete(message.key);
		if (message.type === "cache-deleted") {
			emit(message.spaceId, {
				labels: [],
				updatedAt: message.updatedAt,
				stale: true,
				source: "indexeddb",
			});
			return;
		}
		void readRecord(message.spaceId).then((result) => {
			if (result)
				emit(message.spaceId as string, toSnapshot(result.record, "indexeddb"));
		});
	});
}

export const labelTreeRepo = {
	async get(spaceId: string) {
		ensureBroadcastSubscription();
		const result = await readRecord(spaceId);
		return result ? toSnapshot(result.record, result.source) : null;
	},

	async refresh(spaceId: string, fetcher: () => Promise<LabelListItem[]>) {
		ensureBroadcastSubscription();
		const labels = await fetcher();
		const record = await writeRecord(spaceId, labels, { source: "network" });
		return { ...toSnapshot(record, "network"), stale: false };
	},

	async set(
		spaceId: string,
		labels: LabelListItem[],
		options?: { broadcast?: boolean; source?: CacheSource },
	) {
		ensureBroadcastSubscription();
		const record = await writeRecord(spaceId, labels, options);
		return toSnapshot(record, options?.source ?? "indexeddb");
	},

	async patch(
		spaceId: string,
		updater: (labels: LabelListItem[]) => LabelListItem[],
	) {
		const current = await readRecord(spaceId);
		const record = await writeRecord(
			spaceId,
			updater(current?.record.labels ?? []),
		);
		return toSnapshot(record, "indexeddb");
	},

	async delete(spaceId: string) {
		const userKey = getCacheUserKey();
		const key = labelTreeKey(userKey, spaceId);
		memory.delete(key);
		await idbDelete("label_trees", key);
		publishCacheMessage({
			type: "cache-deleted",
			store: "label_trees",
			key,
			userKey,
			spaceId,
			updatedAt: Date.now(),
		});
	},

	subscribe(spaceId: string, handler: (snapshot: LabelTreeSnapshot) => void) {
		ensureBroadcastSubscription();
		const listener = (snapshot: LabelTreeSnapshot & { spaceId: string }) => {
			if (snapshot.spaceId === spaceId) handler(snapshot);
		};
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};
