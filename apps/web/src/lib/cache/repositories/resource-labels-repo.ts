import type { LabelAssignmentRecord, LabelListItem } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "#lib/cache/broadcast.ts";
import {
	idbDelete,
	idbGet,
	idbPut,
	type ResourceLabelsCacheRecord,
} from "#lib/cache/db.ts";
import { getCacheUserKey, resourceLabelsKey } from "#lib/cache/keys.ts";
import { MemoryLru } from "#lib/cache/memory-lru.ts";
import type { CacheSource } from "#lib/cache/types.ts";

const RESOURCE_LABELS_TTL_MS = 30_000;
const memory = new MemoryLru<string, ResourceLabelsCacheRecord>(100);
const listeners = new Set<
	(
		snapshot: ResourceLabelsSnapshot & {
			spaceId: string;
			resourceType: string;
			resourceRef: string;
		},
	) => void
>();
let subscribedToBroadcast = false;

export type ResourceLabelsSnapshot = {
	labels: LabelListItem[];
	assignments: LabelAssignmentRecord[];
	updatedAt: number;
	stale: boolean;
	source: CacheSource;
};

function normalizeLabels(labels: LabelListItem[]) {
	return Array.isArray(labels) ? labels : [];
}

function normalizeAssignments(assignments: LabelAssignmentRecord[]) {
	return Array.isArray(assignments) ? assignments : [];
}

function toSnapshot(
	record: ResourceLabelsCacheRecord,
	source: CacheSource,
): ResourceLabelsSnapshot {
	return {
		labels: record.labels,
		assignments: record.assignments,
		updatedAt: record.updatedAt,
		stale: Date.now() - record.updatedAt >= RESOURCE_LABELS_TTL_MS,
		source,
	};
}

async function readRecord(
	spaceId: string,
	resourceType: string,
	resourceRef: string,
) {
	const userKey = getCacheUserKey();
	const key = resourceLabelsKey(userKey, spaceId, resourceType, resourceRef);
	const cached = memory.get(key);
	if (cached) return { record: cached, source: "memory" as CacheSource };
	const record = await idbGet<ResourceLabelsCacheRecord>(
		"resource_labels",
		key,
	);
	if (!record) return null;
	const touched = { ...record, lastAccessedAt: Date.now() };
	memory.set(key, touched);
	void idbPut("resource_labels", touched).catch(() => undefined);
	return { record: touched, source: "indexeddb" as CacheSource };
}

async function writeRecord(
	spaceId: string,
	resourceType: string,
	resourceRef: string,
	input: { labels: LabelListItem[]; assignments: LabelAssignmentRecord[] },
	options?: { broadcast?: boolean; source?: CacheSource },
) {
	const userKey = getCacheUserKey();
	const key = resourceLabelsKey(userKey, spaceId, resourceType, resourceRef);
	const now = Date.now();
	const record: ResourceLabelsCacheRecord = {
		key,
		userKey,
		spaceId,
		resourceType,
		resourceRef,
		labels: normalizeLabels(input.labels),
		assignments: normalizeAssignments(input.assignments),
		updatedAt: now,
		lastAccessedAt: now,
	};
	memory.set(key, record);
	await idbPut("resource_labels", record);
	if (options?.broadcast !== false) {
		publishCacheMessage({
			type: "cache-updated",
			store: "resource_labels",
			key,
			userKey,
			spaceId,
			resourceType,
			resourceRef,
			updatedAt: now,
		});
	}
	emit(
		spaceId,
		resourceType,
		resourceRef,
		toSnapshot(record, options?.source ?? "indexeddb"),
	);
	return record;
}

function emit(
	spaceId: string,
	resourceType: string,
	resourceRef: string,
	snapshot: ResourceLabelsSnapshot,
) {
	for (const listener of listeners) {
		listener({ ...snapshot, spaceId, resourceType, resourceRef });
	}
}

function ensureBroadcastSubscription() {
	if (subscribedToBroadcast) return;
	subscribedToBroadcast = true;
	subscribeCacheMessages((message) => {
		if (message.store !== "resource_labels" || !message.spaceId) return;
		if (message.userKey !== getCacheUserKey()) return;
		if (message.key) memory.delete(message.key);
		if (message.type === "cache-deleted") {
			if (!message.resourceType || !message.resourceRef) return;
			emit(
				message.spaceId,
				message.resourceType as string,
				message.resourceRef as string,
				{
					labels: [],
					assignments: [],
					updatedAt: message.updatedAt,
					stale: true,
					source: "indexeddb",
				},
			);
			return;
		}
		if (!message.resourceType || !message.resourceRef) return;
		void readRecord(
			message.spaceId,
			message.resourceType as string,
			message.resourceRef as string,
		).then((result) => {
			if (result) {
				emit(
					message.spaceId as string,
					message.resourceType as string,
					message.resourceRef as string,
					toSnapshot(result.record, "indexeddb"),
				);
			}
		});
	});
}

export const resourceLabelsRepo = {
	async get(spaceId: string, resourceType: string, resourceRef: string) {
		ensureBroadcastSubscription();
		const result = await readRecord(spaceId, resourceType, resourceRef);
		return result ? toSnapshot(result.record, result.source) : null;
	},

	async set(
		spaceId: string,
		resourceType: string,
		resourceRef: string,
		input: { labels: LabelListItem[]; assignments: LabelAssignmentRecord[] },
		options?: { broadcast?: boolean; source?: CacheSource },
	) {
		ensureBroadcastSubscription();
		const record = await writeRecord(
			spaceId,
			resourceType,
			resourceRef,
			input,
			options,
		);
		return toSnapshot(record, options?.source ?? "indexeddb");
	},

	async delete(spaceId: string, resourceType: string, resourceRef: string) {
		const userKey = getCacheUserKey();
		const key = resourceLabelsKey(userKey, spaceId, resourceType, resourceRef);
		memory.delete(key);
		await idbDelete("resource_labels", key);
		publishCacheMessage({
			type: "cache-deleted",
			store: "resource_labels",
			key,
			userKey,
			spaceId,
			resourceType,
			resourceRef,
			updatedAt: Date.now(),
		});
	},

	subscribe(
		spaceId: string,
		resourceType: string,
		resourceRef: string,
		handler: (snapshot: ResourceLabelsSnapshot) => void,
	) {
		ensureBroadcastSubscription();
		const listener = (
			snapshot: ResourceLabelsSnapshot & {
				spaceId: string;
				resourceType: string;
				resourceRef: string;
			},
		) => {
			if (
				snapshot.spaceId === spaceId &&
				snapshot.resourceType === resourceType &&
				snapshot.resourceRef === resourceRef
			) {
				handler(snapshot);
			}
		};
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};
