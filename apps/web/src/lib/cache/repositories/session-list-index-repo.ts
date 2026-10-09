import type { SessionRecord } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "$lib/cache/broadcast";
import type { SessionListForkRecord } from "$lib/cache/db";
import {
	idbDelete,
	idbGet,
	idbPut,
	type SessionListIndexCacheRecord,
	type SessionListIndexItem,
} from "$lib/cache/db";
import { getCacheUserKey, sessionListIndexKey } from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";
import { sessionDetailRepo } from "$lib/cache/repositories/session-detail-repo";
import {
	type CacheSource,
	DEFAULT_SESSION_LIST_PAGE_INFO,
	type SessionListPageInfo,
} from "$lib/cache/types";
import { mergeSessionRecords } from "$lib/session-record-merge";
import {
	getSessionActivityAt,
	sortSessionsByRecentActivity,
} from "$lib/session-sort";

const SESSION_LIST_INDEX_TTL_MS = 30_000;
const MAX_CACHED_SESSION_INDEX_ITEMS_PER_SPACE = 500;
const memory = new MemoryLru<string, SessionListIndexCacheRecord>(50);
const listeners = new Set<
	(snapshot: SessionListIndexSnapshot & { spaceId: string }) => void
>();
let subscribedToBroadcast = false;

export type SessionListFetchResult = {
	sessions: SessionRecord[];
	forks?: SessionListForkRecord[] | null;
	pageInfo?: SessionListPageInfo | null;
};

export type SessionListIndexSnapshot = {
	items: SessionListIndexItem[];
	sessions: SessionRecord[];
	forks: SessionListForkRecord[];
	pageInfo: SessionListPageInfo;
	updatedAt: number;
	stale: boolean;
	source: CacheSource;
};

function normalizeSessions(sessions: SessionRecord[]) {
	return sortSessionsByRecentActivity(mergeSessionRecords(sessions));
}

function normalizePageInfo(
	pageInfo: SessionListPageInfo | null | undefined,
): SessionListPageInfo {
	return {
		hasMore: Boolean(pageInfo?.hasMore),
		nextCursor: pageInfo?.nextCursor ?? null,
	};
}

function iso(value: string | Date | null | undefined) {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString();
	return value;
}

function toIndexItem(session: SessionRecord): SessionListIndexItem {
	return {
		sessionId: session.id,
		activityAt: iso(getSessionActivityAt(session)),
		lastMessageAt: iso(session.lastMessageAt),
		updatedAt: iso(session.updatedAt),
		lastMessageId: session.lastMessageId ?? null,
		preview: {
			title: session.title ?? null,
			latestMessageText: session.latestMessageText ?? null,
			source: session.source ?? null,
			status: session.status ?? null,
			activeTurn: session.activeTurn,
			lastTurnIssue: session.lastTurnIssue,
			userProfile: session.userProfile,
			participantProfiles: session.participantProfiles,
		},
	};
}

function normalizeItems(items: SessionListIndexItem[]) {
	const byId = new Map<string, SessionListIndexItem>();
	for (const item of items) byId.set(item.sessionId, item);
	return Array.from(byId.values()).slice(
		0,
		MAX_CACHED_SESSION_INDEX_ITEMS_PER_SPACE,
	);
}

function getListCursor(item: SessionListIndexItem | null | undefined) {
	if (!item?.lastMessageAt) return null;
	return `${item.lastMessageAt}|${item.sessionId}`;
}

function getMergedPageInfo(input: {
	items: SessionListIndexItem[];
	dropped: boolean;
	incomingPageInfo?: SessionListPageInfo | null;
	currentPageInfo?: SessionListPageInfo | null;
}) {
	if (input.dropped) {
		return {
			hasMore: true,
			nextCursor: getListCursor(input.items.at(-1)),
		};
	}
	return input.incomingPageInfo ?? input.currentPageInfo;
}

function mergeItems(
	current: SessionListIndexItem[] | null | undefined,
	incoming: SessionListIndexItem[],
) {
	const byId = new Map<string, SessionListIndexItem>();
	for (const item of current ?? []) byId.set(item.sessionId, item);
	for (const item of incoming) byId.set(item.sessionId, item);
	const sorted = Array.from(byId.values()).sort((a, b) => {
		const aTime = a.activityAt ?? a.lastMessageAt ?? a.updatedAt ?? "";
		const bTime = b.activityAt ?? b.lastMessageAt ?? b.updatedAt ?? "";
		if (aTime !== bTime) return bTime.localeCompare(aTime);
		return b.sessionId.localeCompare(a.sessionId);
	});
	return {
		items: sorted.slice(0, MAX_CACHED_SESSION_INDEX_ITEMS_PER_SPACE),
		dropped: sorted.length > MAX_CACHED_SESSION_INDEX_ITEMS_PER_SPACE,
	};
}

function sessionFromPreview(
	spaceId: string,
	item: SessionListIndexItem,
): SessionRecord {
	const timestamp =
		item.updatedAt ??
		item.lastMessageAt ??
		item.activityAt ??
		new Date(0).toISOString();
	return {
		id: item.sessionId,
		spaceId,
		userUuid: item.preview.userProfile?.userUuid ?? null,
		userProfile: item.preview.userProfile ?? null,
		participantUserUuids:
			item.preview.participantProfiles
				?.map((profile) => profile.userUuid)
				.filter((uuid): uuid is string => Boolean(uuid)) ?? [],
		participantProfiles: item.preview.participantProfiles ?? [],
		title: item.preview.title,
		source: item.preview.source,
		status: item.preview.status,
		activeTurn: item.preview.activeTurn,
		lastTurnIssue: item.preview.lastTurnIssue,
		externalSessionId: null,
		meta: null,
		latestMessageText: item.preview.latestMessageText,
		lastMessageAt: item.lastMessageAt,
		lastMessageId: item.lastMessageId,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

async function hydrateSessions(spaceId: string, items: SessionListIndexItem[]) {
	const details = await sessionDetailRepo.getMany(
		spaceId,
		items.map((item) => item.sessionId),
	);
	return items.map((item) => {
		const detail = details[item.sessionId]?.session;
		return detail ?? sessionFromPreview(spaceId, item);
	});
}

async function toSnapshot(
	record: SessionListIndexCacheRecord,
	source: CacheSource,
): Promise<SessionListIndexSnapshot> {
	return {
		items: record.items,
		sessions: await hydrateSessions(record.spaceId, record.items),
		forks: record.forks ?? [],
		pageInfo: record.pageInfo,
		updatedAt: record.updatedAt,
		stale: Date.now() - record.updatedAt >= SESSION_LIST_INDEX_TTL_MS,
		source,
	};
}

async function readRecord(spaceId: string) {
	const userKey = getCacheUserKey();
	const key = sessionListIndexKey(userKey, spaceId);
	const cached = memory.get(key);
	if (cached) return { record: cached, source: "memory" as CacheSource };
	const record = await idbGet<SessionListIndexCacheRecord>(
		"session_list_indexes",
		key,
	);
	if (!record) return null;
	const touched = { ...record, lastAccessedAt: Date.now() };
	memory.set(key, touched);
	void idbPut("session_list_indexes", touched).catch(() => undefined);
	return { record: touched, source: "indexeddb" as CacheSource };
}

async function writeRecord(
	spaceId: string,
	items: SessionListIndexItem[],
	pageInfo?: SessionListPageInfo | null,
	forks?: SessionListForkRecord[] | null,
	options?: { broadcast?: boolean; completeness?: "partial" | "complete" },
) {
	const userKey = getCacheUserKey();
	const key = sessionListIndexKey(userKey, spaceId);
	const now = Date.now();
	const normalized = normalizeItems(items);
	const record: SessionListIndexCacheRecord = {
		key,
		userKey,
		spaceId,
		kind: "recent",
		items: normalized,
		forks: forks ?? [],
		pageInfo: normalizePageInfo(pageInfo),
		updatedAt: now,
		lastAccessedAt: now,
		watermark: normalized[0]?.updatedAt ?? normalized[0]?.activityAt ?? null,
		completeness: options?.completeness ?? "partial",
	};
	memory.set(key, record);
	await idbPut("session_list_indexes", record);
	if (options?.broadcast !== false) {
		publishCacheMessage({
			type: "cache-updated",
			store: "session_list_indexes",
			key,
			userKey,
			spaceId,
			updatedAt: now,
		});
	}
	emit(spaceId, await toSnapshot(record, "indexeddb"));
	return record;
}

function emit(spaceId: string, snapshot: SessionListIndexSnapshot) {
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent("cohub:session-list-cache-updated", {
				detail: {
					spaceId,
					sessions: snapshot.sessions,
					forks: snapshot.forks,
					pageInfo: snapshot.pageInfo,
				},
			}),
		);
	}
	for (const listener of listeners) listener({ ...snapshot, spaceId });
}

function ensureBroadcastSubscription() {
	if (subscribedToBroadcast) return;
	subscribedToBroadcast = true;
	subscribeCacheMessages((message) => {
		if (message.store !== "session_list_indexes" || !message.spaceId) return;
		if (message.userKey !== getCacheUserKey()) return;
		if (message.key) memory.delete(message.key);
		if (message.type === "cache-deleted") {
			emit(message.spaceId, {
				items: [],
				sessions: [],
				forks: [],
				pageInfo: DEFAULT_SESSION_LIST_PAGE_INFO,
				updatedAt: message.updatedAt,
				stale: true,
				source: "indexeddb",
			});
			return;
		}
		void readRecord(message.spaceId).then(async (result) => {
			if (result)
				emit(
					message.spaceId as string,
					await toSnapshot(result.record, "indexeddb"),
				);
		});
	});
}

export const sessionListIndexRepo = {
	async getRecent(spaceId: string) {
		ensureBroadcastSubscription();
		const result = await readRecord(spaceId);
		return result ? await toSnapshot(result.record, result.source) : null;
	},

	async refreshRecent(
		spaceId: string,
		fetcher: () => Promise<SessionListFetchResult>,
	) {
		ensureBroadcastSubscription();
		const [current, result] = await Promise.all([
			readRecord(spaceId),
			fetcher(),
		]);
		const sessions = normalizeSessions(result.sessions);
		await sessionDetailRepo.setMany(spaceId, sessions, { broadcast: false });
		const record = await writeRecord(
			spaceId,
			sessions.map(toIndexItem),
			result.pageInfo ?? DEFAULT_SESSION_LIST_PAGE_INFO,
			result.forks !== undefined ? result.forks : current?.record.forks,
			{ completeness: "partial" },
		);
		return { ...(await toSnapshot(record, "network")), stale: false };
	},

	async setRecent(
		spaceId: string,
		sessions: SessionRecord[],
		pageInfo?: SessionListPageInfo | null,
		forks?: SessionListForkRecord[] | null,
		options?: { mode?: "replace" | "merge" },
	) {
		const current = await readRecord(spaceId);
		const normalized = normalizeSessions(sessions);
		await sessionDetailRepo.setMany(spaceId, normalized, { broadcast: false });
		const incoming = normalized.map(toIndexItem);
		const merged =
			options?.mode === "merge"
				? mergeItems(current?.record.items, incoming)
				: { items: normalizeItems(incoming), dropped: false };
		const record = await writeRecord(
			spaceId,
			merged.items,
			options?.mode === "merge"
				? getMergedPageInfo({
						items: merged.items,
						dropped: merged.dropped,
						incomingPageInfo: pageInfo,
						currentPageInfo: current?.record.pageInfo,
					})
				: (pageInfo ?? current?.record.pageInfo),
			forks !== undefined ? forks : current?.record.forks,
		);
		return toSnapshot(record, "indexeddb");
	},

	async patchRecent(
		spaceId: string,
		updater: (sessions: SessionRecord[]) => SessionRecord[],
		pageInfo?: SessionListPageInfo | null,
		forks?: SessionListForkRecord[] | null,
	) {
		const current = await readRecord(spaceId);
		const currentSessions = current
			? await hydrateSessions(spaceId, current.record.items)
			: [];
		const updated = normalizeSessions(updater(currentSessions));
		await sessionDetailRepo.setMany(spaceId, updated, { broadcast: false });
		const record = await writeRecord(
			spaceId,
			updated.map(toIndexItem),
			pageInfo !== undefined ? pageInfo : current?.record.pageInfo,
			forks !== undefined ? forks : current?.record.forks,
		);
		return toSnapshot(record, "indexeddb");
	},

	async deleteRecent(spaceId: string) {
		const userKey = getCacheUserKey();
		const key = sessionListIndexKey(userKey, spaceId);
		memory.delete(key);
		await idbDelete("session_list_indexes", key);
		publishCacheMessage({
			type: "cache-deleted",
			store: "session_list_indexes",
			key,
			userKey,
			spaceId,
			updatedAt: Date.now(),
		});
	},

	subscribe(
		spaceId: string,
		handler: (snapshot: SessionListIndexSnapshot) => void,
	) {
		ensureBroadcastSubscription();
		const listener = (
			snapshot: SessionListIndexSnapshot & { spaceId: string },
		) => {
			if (snapshot.spaceId === spaceId) handler(snapshot);
		};
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};

export { normalizeSessions as normalizeSessionList };
