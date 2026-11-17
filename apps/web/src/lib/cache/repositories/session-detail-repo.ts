import { sanitizeSessionRecordStats } from "@cohub/protocol/model";
import type { SessionRecord } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "#lib/cache/broadcast.ts";
import {
	idbDelete,
	idbGet,
	idbGetByIndex,
	idbPut,
	type SessionDetailCacheRecord,
} from "#lib/cache/db.ts";
import { getCacheUserKey, sessionDetailKey } from "#lib/cache/keys.ts";
import { MemoryLru } from "#lib/cache/memory-lru.ts";
import type { CacheSource } from "#lib/cache/types.ts";
import { sessionMatchesContext } from "#lib/session-context.ts";

const SESSION_DETAIL_TTL_MS = 60_000;
const memory = new MemoryLru<string, SessionDetailCacheRecord>(500);
const listeners = new Set<
	(
		snapshot: SessionDetailSnapshot & { spaceId: string; sessionId: string },
	) => void
>();
const remoteListeners = new Set<(session: SessionRecord) => void>();
let subscribedToBroadcast = false;

export type SessionDetailSnapshot = {
	session: SessionRecord;
	updatedAt: number;
	stale: boolean;
	source: CacheSource;
};

function getWatermark(session: SessionRecord) {
	return (
		session.updatedAt ?? session.lastMessageAt ?? session.createdAt ?? null
	);
}

function toSnapshot(
	record: SessionDetailCacheRecord,
	source: CacheSource,
): SessionDetailSnapshot {
	return {
		session: sanitizeSessionRecordStats(record.session),
		updatedAt: record.updatedAt,
		stale: Date.now() - record.updatedAt >= SESSION_DETAIL_TTL_MS,
		source,
	};
}

function remember(record: SessionDetailCacheRecord) {
	const touched = {
		...record,
		session: sanitizeSessionRecordStats(record.session),
		lastAccessedAt: Date.now(),
	};
	memory.set(record.key, touched);
	void idbPut("session_details", touched).catch(() => undefined);
	return touched;
}

async function readRecord(spaceId: string, sessionId: string) {
	const userKey = getCacheUserKey();
	const key = sessionDetailKey(userKey, spaceId, sessionId);
	const cached = memory.get(key);
	if (cached) {
		return sessionMatchesContext(cached.session, spaceId, sessionId)
			? { record: cached, source: "memory" as CacheSource }
			: null;
	}
	const record = await idbGet<SessionDetailCacheRecord>("session_details", key);
	if (!record || !sessionMatchesContext(record.session, spaceId, sessionId))
		return null;
	return { record: remember(record), source: "indexeddb" as CacheSource };
}

async function writeRecord(
	spaceId: string,
	session: SessionRecord,
	options?: { broadcast?: boolean; source?: CacheSource; updatedAt?: number },
) {
	if (!sessionMatchesContext(session, spaceId, session.id)) {
		throw new Error("Session cache context mismatch");
	}
	session = sanitizeSessionRecordStats(session);
	const userKey = getCacheUserKey();
	const key = sessionDetailKey(userKey, spaceId, session.id);
	const now = Date.now();
	const record: SessionDetailCacheRecord = {
		key,
		userKey,
		spaceId,
		sessionId: session.id,
		session,
		updatedAt: options?.updatedAt ?? now,
		lastAccessedAt: now,
		watermark: getWatermark(session),
	};
	memory.set(key, record);
	// Memory is the live source for the current tab. Persist in the background so
	// large label/session hydrations never block UI after network success.
	void idbPut("session_details", record).catch((error) => {
		console.warn("[session-detail] Failed to persist", {
			spaceId,
			sessionId: session.id,
			error,
		});
	});
	if (options?.broadcast !== false) {
		publishCacheMessage({
			type: "cache-updated",
			store: "session_details",
			key,
			userKey,
			spaceId,
			sessionId: session.id,
			updatedAt: now,
		});
	}
	const snapshot = toSnapshot(record, options?.source ?? "indexeddb");
	emit(spaceId, session.id, snapshot);
	return record;
}

function emit(
	spaceId: string,
	sessionId: string,
	snapshot: SessionDetailSnapshot,
) {
	for (const listener of listeners)
		listener({ ...snapshot, spaceId, sessionId });
}

function ensureBroadcastSubscription() {
	if (subscribedToBroadcast) return;
	subscribedToBroadcast = true;
	subscribeCacheMessages((message) => {
		if (message.store !== "session_details" || !message.spaceId) return;
		if (message.userKey !== getCacheUserKey()) return;
		if (message.key) memory.delete(message.key);
		if (!message.sessionId) return;
		if (message.type === "cache-deleted") return;
		void readRecord(message.spaceId, message.sessionId).then((result) => {
			if (!result) return;
			const snapshot = toSnapshot(result.record, "indexeddb");
			emit(message.spaceId as string, message.sessionId as string, snapshot);
			for (const listener of remoteListeners) listener(snapshot.session);
		});
	});
}

export const sessionDetailRepo = {
	async get(spaceId: string, sessionId: string) {
		ensureBroadcastSubscription();
		const result = await readRecord(spaceId, sessionId);
		return result ? toSnapshot(result.record, result.source) : null;
	},

	async find(sessionId: string) {
		ensureBroadcastSubscription();
		const record = await idbGetByIndex<SessionDetailCacheRecord>(
			"session_details",
			"by_user_session",
			[getCacheUserKey(), sessionId],
		);
		if (
			!record ||
			!sessionMatchesContext(record.session, record.spaceId, sessionId)
		)
			return null;
		const cached = memory.get(record.key);
		return {
			spaceId: record.spaceId,
			...(cached
				? toSnapshot(cached, "memory")
				: toSnapshot(remember(record), "indexeddb")),
		};
	},

	async getMany(spaceId: string, sessionIds: string[]) {
		ensureBroadcastSubscription();
		const entries = await Promise.all(
			Array.from(new Set(sessionIds)).map(
				async (sessionId) =>
					[sessionId, await readRecord(spaceId, sessionId)] as const,
			),
		);
		return Object.fromEntries(
			entries.flatMap(([sessionId, result]) =>
				result ? [[sessionId, toSnapshot(result.record, result.source)]] : [],
			),
		) as Record<string, SessionDetailSnapshot>;
	},

	async set(
		spaceId: string,
		session: SessionRecord,
		options?: { broadcast?: boolean; source?: CacheSource },
	) {
		ensureBroadcastSubscription();
		const record = await writeRecord(spaceId, session, options);
		return toSnapshot(record, options?.source ?? "indexeddb");
	},

	async setMany(
		spaceId: string,
		sessions: SessionRecord[],
		options?: { broadcast?: boolean; source?: CacheSource },
	) {
		ensureBroadcastSubscription();
		const snapshots = await Promise.all(
			sessions.map(
				async (session) =>
					[
						session.id,
						toSnapshot(
							await writeRecord(spaceId, session, options),
							options?.source ?? "indexeddb",
						),
					] as const,
			),
		);
		return Object.fromEntries(snapshots) as Record<
			string,
			SessionDetailSnapshot
		>;
	},

	async delete(spaceId: string, sessionId: string) {
		const userKey = getCacheUserKey();
		const key = sessionDetailKey(userKey, spaceId, sessionId);
		memory.delete(key);
		await idbDelete("session_details", key);
		publishCacheMessage({
			type: "cache-deleted",
			store: "session_details",
			key,
			userKey,
			spaceId,
			sessionId,
			updatedAt: Date.now(),
		});
	},

	onRemote(handler: (session: SessionRecord) => void) {
		ensureBroadcastSubscription();
		remoteListeners.add(handler);
		return () => remoteListeners.delete(handler);
	},

	subscribe(
		spaceId: string,
		sessionId: string,
		handler: (snapshot: SessionDetailSnapshot) => void,
	) {
		ensureBroadcastSubscription();
		const listener = (
			snapshot: SessionDetailSnapshot & { spaceId: string; sessionId: string },
		) => {
			if (snapshot.spaceId === spaceId && snapshot.sessionId === sessionId) {
				handler(snapshot);
			}
		};
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};
