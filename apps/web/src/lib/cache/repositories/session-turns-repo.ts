import type { SessionTurnRecord } from "@cohub/protocol/model";
import type { SessionRecord } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "$lib/cache/broadcast";
import {
	idbDelete,
	idbGet,
	idbGetByIndex,
	idbPut,
	type SessionTurnsCacheRecord,
} from "$lib/cache/db";
import { createKeyedSerialQueue } from "$lib/cache/keyed-serial-queue";
import { getCacheUserKey, sessionTurnsKey } from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";
import {
	persistSessionTurnsCacheSafely,
	readSessionTurnsCacheSafely,
} from "$lib/cache/repositories/session-turns-cache-safety";
import type { CacheSource } from "$lib/cache/types";
import { areSessionTurnRecordsEqual } from "$lib/session-turn-equality";
import { mergeTurnsById } from "$lib/stores/turn-cache";

const SESSION_TURNS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TURNS_PER_SESSION_CACHE = 500;
const memory = new MemoryLru<string, SessionTurnsCacheRecord>(50);
const runMutation = createKeyedSerialQueue();
const listeners = new Set<
	(
		snapshot: SessionTurnsSnapshot & { spaceId: string; sessionId: string },
	) => void
>();
let subscribedToBroadcast = false;

function runSessionMutation<T>(
	spaceId: string,
	sessionId: string,
	mutation: () => T | Promise<T>,
) {
	return runMutation(
		sessionTurnsKey(getCacheUserKey(), spaceId, sessionId),
		mutation,
	);
}

export type SessionTurnsSnapshot = {
	session: SessionRecord | null;
	turns: SessionTurnRecord[];
	hasMoreOlder: boolean;
	hasMoreNewer: boolean;
	oldestSequence: number | null;
	newestSequence: number | null;
	updatedAt: number;
	stale: boolean;
	source: CacheSource;
};

function getOldestSequence(turns: SessionTurnRecord[]) {
	return turns.length > 0 ? turns[0].sequence : null;
}

function getNewestSequence(turns: SessionTurnRecord[]) {
	return turns.length > 0 ? (turns.at(-1)?.sequence ?? null) : null;
}

function getNewestTurn(turns: SessionTurnRecord[]) {
	return turns.length > 0 ? (turns.at(-1) ?? null) : null;
}

function trimTurns(
	turns: SessionTurnRecord[],
	options?: { mode?: "head" | "tail"; anchorSequence?: number | null },
) {
	if (turns.length <= MAX_TURNS_PER_SESSION_CACHE) return turns;
	const anchorSequence = options?.anchorSequence;
	if (anchorSequence != null) {
		const foundIndex = turns.findIndex(
			(turn) => turn.sequence >= anchorSequence,
		);
		const anchorIndex =
			foundIndex >= 0
				? foundIndex
				: anchorSequence < (turns[0]?.sequence ?? 0)
					? 0
					: turns.length - 1;
		const half = Math.floor(MAX_TURNS_PER_SESSION_CACHE / 2);
		const start = Math.min(
			Math.max(0, anchorIndex - half),
			Math.max(0, turns.length - MAX_TURNS_PER_SESSION_CACHE),
		);
		return turns.slice(start, start + MAX_TURNS_PER_SESSION_CACHE);
	}
	return options?.mode === "head"
		? turns.slice(0, MAX_TURNS_PER_SESSION_CACHE)
		: turns.slice(-MAX_TURNS_PER_SESSION_CACHE);
}

function parseTurnUpdatedAt(turn: SessionTurnRecord | null | undefined) {
	if (!turn?.updatedAt) return 0;
	const value = Date.parse(turn.updatedAt);
	return Number.isFinite(value) ? value : 0;
}

function isIncomingTailOlder(input: {
	currentTurns: SessionTurnRecord[];
	incomingTurns: SessionTurnRecord[];
}) {
	const currentNewest = getNewestTurn(input.currentTurns);
	const incomingNewest = getNewestTurn(input.incomingTurns);
	if (!currentNewest || !incomingNewest) return false;
	if (incomingNewest.sequence < currentNewest.sequence) return true;
	if (incomingNewest.sequence > currentNewest.sequence) return false;
	return parseTurnUpdatedAt(incomingNewest) < parseTurnUpdatedAt(currentNewest);
}

function areJsonEqual(a: unknown, b: unknown) {
	if (a === b) return true;
	if (a == null || b == null) return a === b;
	if (typeof a !== "object" || typeof b !== "object") return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

function areTurnListsEqual(
	currentTurns: SessionTurnRecord[],
	nextTurns: SessionTurnRecord[],
) {
	if (currentTurns.length !== nextTurns.length) return false;
	return currentTurns.every((turn, index) =>
		areSessionTurnRecordsEqual(turn, nextTurns[index]),
	);
}

function reconcileTailTurns(
	currentTurns: SessionTurnRecord[],
	incomingTurns: SessionTurnRecord[],
) {
	if (incomingTurns.length === 0) return [];
	const incomingOldestSequence = incomingTurns[0]?.sequence ?? 0;
	const preservedOlderTurns = currentTurns.filter(
		(turn) => turn.sequence < incomingOldestSequence,
	);
	return mergeTurnsById(preservedOlderTurns, incomingTurns, {
		preferIncoming: true,
	});
}

function toSnapshot(
	record: SessionTurnsCacheRecord,
	source: CacheSource,
): SessionTurnsSnapshot {
	return {
		session: record.session,
		turns: record.turns,
		hasMoreOlder: record.hasMoreOlder,
		hasMoreNewer: Boolean(
			(record as SessionTurnsCacheRecord & { hasMoreNewer?: boolean })
				.hasMoreNewer,
		),
		oldestSequence: record.oldestSequence,
		newestSequence: record.newestSequence,
		updatedAt: record.updatedAt,
		stale: Date.now() - record.updatedAt >= SESSION_TURNS_TTL_MS,
		source,
	};
}

function toSnapshotWithTurns(
	record: SessionTurnsCacheRecord,
	source: CacheSource,
	turns: SessionTurnRecord[],
): SessionTurnsSnapshot {
	return {
		...toSnapshot(record, source),
		turns,
		oldestSequence: getOldestSequence(turns),
		newestSequence: getNewestSequence(turns),
	};
}

async function readRecord(spaceId: string, sessionId: string) {
	const userKey = getCacheUserKey();
	const key = sessionTurnsKey(userKey, spaceId, sessionId);
	const cached = memory.get(key);
	if (cached) return { record: cached, source: "memory" as CacheSource };
	const record = await readSessionTurnsCacheSafely({
		read: () => idbGet<SessionTurnsCacheRecord>("session_turns", key),
		onError: (error) =>
			console.warn("[sessionTurnsRepo] Failed to read turn cache:", error),
	});
	if (!record) return null;
	return { record: remember(record), source: "indexeddb" as CacheSource };
}

function remember(record: SessionTurnsCacheRecord) {
	const touched = { ...record, lastAccessedAt: Date.now() };
	memory.set(record.key, touched);
	return touched;
}

async function writeRecord(
	spaceId: string,
	sessionId: string,
	input: {
		session: SessionRecord | null;
		turns: SessionTurnRecord[];
		hasMoreOlder: boolean;
		hasMoreNewer?: boolean;
		reconciledAt?: number;
	},
	options?: {
		broadcast?: boolean;
		source?: CacheSource;
		trimMode?: "head" | "tail";
		trimAnchorSequence?: number | null;
	},
) {
	const userKey = getCacheUserKey();
	const key = sessionTurnsKey(userKey, spaceId, sessionId);
	const now = Date.now();
	const sortedTurns = [...input.turns].sort((a, b) => a.sequence - b.sequence);
	const turns = trimTurns(sortedTurns, {
		mode: options?.trimMode,
		anchorSequence: options?.trimAnchorSequence,
	});
	const record: SessionTurnsCacheRecord = {
		key,
		userKey,
		spaceId,
		sessionId,
		session: input.session,
		turns,
		newestSequence: getNewestSequence(turns),
		oldestSequence: getOldestSequence(turns),
		hasMoreOlder: input.hasMoreOlder,
		...(input.hasMoreNewer !== undefined
			? { hasMoreNewer: input.hasMoreNewer }
			: {}),
		reconciledAt: input.reconciledAt ?? now,
		updatedAt: now,
		lastAccessedAt: now,
		tailWatermark: turns.at(-1)?.updatedAt ?? null,
	};
	memory.set(key, record);
	await persistSessionTurnsCacheSafely({
		write: () => idbPut("session_turns", record),
		onError: (error) =>
			console.warn("[sessionTurnsRepo] Failed to persist turn cache:", error),
	});
	if (options?.broadcast !== false) {
		publishCacheMessage({
			type: "cache-updated",
			store: "session_turns",
			key,
			userKey,
			spaceId,
			sessionId,
			updatedAt: now,
		});
	}
	emit(spaceId, sessionId, toSnapshot(record, options?.source ?? "indexeddb"));
	return record;
}

function emit(
	spaceId: string,
	sessionId: string,
	snapshot: SessionTurnsSnapshot,
) {
	for (const listener of listeners)
		listener({ ...snapshot, spaceId, sessionId });
}

function ensureBroadcastSubscription() {
	if (subscribedToBroadcast) return;
	subscribedToBroadcast = true;
	subscribeCacheMessages((message) => {
		if (
			message.store !== "session_turns" ||
			!message.spaceId ||
			!message.sessionId
		)
			return;
		if (message.userKey !== getCacheUserKey()) return;
		if (message.key) memory.delete(message.key);
		if (message.type === "cache-deleted") {
			emit(message.spaceId, message.sessionId, {
				session: null,
				turns: [],
				hasMoreOlder: false,
				hasMoreNewer: false,
				oldestSequence: null,
				newestSequence: null,
				updatedAt: message.updatedAt,
				stale: true,
				source: "indexeddb",
			});
			return;
		}
		void readRecord(message.spaceId, message.sessionId).then((result) => {
			if (result)
				emit(
					message.spaceId as string,
					message.sessionId as string,
					toSnapshot(result.record, "indexeddb"),
				);
		});
	});
}

export const sessionTurnsRepo = {
	async getCached(spaceId: string, sessionId: string) {
		ensureBroadcastSubscription();
		const result = await readRecord(spaceId, sessionId);
		return result ? toSnapshot(result.record, result.source) : null;
	},

	async find(sessionId: string) {
		ensureBroadcastSubscription();
		const record = await readSessionTurnsCacheSafely({
			read: () =>
				idbGetByIndex<SessionTurnsCacheRecord>(
					"session_turns",
					"by_user_session",
					[getCacheUserKey(), sessionId],
				),
			onError: (error) =>
				console.warn("[sessionTurnsRepo] Failed to find turn cache:", error),
		});
		if (!record) return null;
		const cached = memory.get(record.key);
		return {
			spaceId: record.spaceId,
			...(cached
				? toSnapshot(cached, "memory")
				: toSnapshot(remember(record), "indexeddb")),
		};
	},

	async replaceTail(
		spaceId: string,
		sessionId: string,
		response: {
			session: SessionRecord;
			turns: SessionTurnRecord[];
			hasMore: boolean;
		},
		options?: { source?: CacheSource },
	) {
		return runSessionMutation(spaceId, sessionId, async () => {
			ensureBroadcastSubscription();
			const current = await readRecord(spaceId, sessionId);
			if (
				current &&
				isIncomingTailOlder({
					currentTurns: current.record.turns,
					incomingTurns: response.turns,
				})
			) {
				return toSnapshot(current.record, current.source);
			}

			const currentTurns = current?.record.turns ?? [];
			const nextTurns = reconcileTailTurns(currentTurns, response.turns);
			const keptLocalOlderTurns = Boolean(
				currentTurns.length > 0 &&
					response.turns.length > 0 &&
					currentTurns.some(
						(turn) => turn.sequence < (response.turns[0]?.sequence ?? 0),
					),
			);
			const nextHasMoreOlder = keptLocalOlderTurns
				? current?.record.hasMoreOlder === true
				: response.hasMore;
			const nextHasMoreNewer = false;
			const source = options?.source ?? "network";
			if (
				current &&
				areJsonEqual(current.record.session, response.session) &&
				current.record.hasMoreOlder === nextHasMoreOlder &&
				Boolean(
					(
						current.record as SessionTurnsCacheRecord & {
							hasMoreNewer?: boolean;
						}
					).hasMoreNewer,
				) === nextHasMoreNewer &&
				areTurnListsEqual(current.record.turns, nextTurns)
			) {
				return toSnapshot(current.record, current.source);
			}

			const record = await writeRecord(
				spaceId,
				sessionId,
				{
					session: response.session,
					turns: nextTurns,
					hasMoreOlder: nextHasMoreOlder,
					hasMoreNewer: nextHasMoreNewer,
				},
				{ source },
			);
			return toSnapshot(record, source);
		});
	},

	async mergeTurns(
		spaceId: string,
		sessionId: string,
		turns: SessionTurnRecord[],
		options?: {
			session?: SessionRecord | null;
			preferIncoming?: boolean;
			hasMoreOlder?: boolean;
			hasMoreNewer?: boolean;
			source?: CacheSource;
			trimAnchorSequence?: number | null;
		},
	) {
		return runSessionMutation(spaceId, sessionId, async () => {
			ensureBroadcastSubscription();
			const current = await readRecord(spaceId, sessionId);
			const merged = mergeTurnsById(current?.record.turns ?? [], turns, {
				preferIncoming: options?.preferIncoming ?? true,
			});
			const record = await writeRecord(
				spaceId,
				sessionId,
				{
					session: options?.session ?? current?.record.session ?? null,
					turns: merged,
					hasMoreOlder:
						options?.hasMoreOlder ?? current?.record.hasMoreOlder ?? false,
					hasMoreNewer:
						options?.hasMoreNewer ??
						Boolean(
							(
								current?.record as
									| (SessionTurnsCacheRecord & { hasMoreNewer?: boolean })
									| undefined
							)?.hasMoreNewer,
						),
				},
				{
					source: options?.source ?? "indexeddb",
					trimAnchorSequence: options?.trimAnchorSequence,
				},
			);
			return toSnapshotWithTurns(
				record,
				options?.source ?? "indexeddb",
				merged,
			);
		});
	},

	async replaceTurnId(
		spaceId: string,
		sessionId: string,
		input: { previousTurnId: string; nextTurnId: string },
		options?: { source?: CacheSource },
	) {
		return runSessionMutation(spaceId, sessionId, async () => {
			ensureBroadcastSubscription();
			if (input.previousTurnId === input.nextTurnId) {
				const current = await readRecord(spaceId, sessionId);
				return current ? toSnapshot(current.record, current.source) : null;
			}
			const current = await readRecord(spaceId, sessionId);
			if (!current) return null;
			const remappedTurns = current.record.turns.map((turn) => {
				if (turn.id !== input.previousTurnId) return turn;
				const meta = turn.meta ? { ...turn.meta } : null;
				if (meta && "optimistic" in meta) delete meta.optimistic;
				return {
					...turn,
					id: input.nextTurnId,
					meta,
				};
			});
			const merged = mergeTurnsById([], remappedTurns, {
				preferIncoming: true,
			});
			const record = await writeRecord(
				spaceId,
				sessionId,
				{
					session: current.record.session,
					turns: merged,
					hasMoreOlder: current.record.hasMoreOlder,
					hasMoreNewer: Boolean(
						(
							current.record as SessionTurnsCacheRecord & {
								hasMoreNewer?: boolean;
							}
						).hasMoreNewer,
					),
					reconciledAt: current.record.reconciledAt,
				},
				{ source: options?.source ?? "indexeddb" },
			);
			return toSnapshot(record, options?.source ?? "indexeddb");
		});
	},

	async loadOlder(
		spaceId: string,
		sessionId: string,
		response: {
			session?: SessionRecord | null;
			turns: SessionTurnRecord[];
			hasMore: boolean;
		},
	) {
		return runSessionMutation(spaceId, sessionId, async () => {
			const current = await readRecord(spaceId, sessionId);
			const merged = mergeTurnsById(
				current?.record.turns ?? [],
				response.turns,
				{
					preferIncoming: false,
				},
			);
			const record = await writeRecord(
				spaceId,
				sessionId,
				{
					session: response.session ?? current?.record.session ?? null,
					turns: merged,
					hasMoreOlder: response.hasMore,
					hasMoreNewer: Boolean(
						(
							current?.record as
								| (SessionTurnsCacheRecord & { hasMoreNewer?: boolean })
								| undefined
						)?.hasMoreNewer,
					),
				},
				{ source: "network", trimMode: "head" },
			);
			return toSnapshotWithTurns(record, "network", merged);
		});
	},

	async clearSession(spaceId: string, sessionId: string) {
		return runSessionMutation(spaceId, sessionId, async () => {
			const userKey = getCacheUserKey();
			const key = sessionTurnsKey(userKey, spaceId, sessionId);
			memory.delete(key);
			await idbDelete("session_turns", key);
			publishCacheMessage({
				type: "cache-deleted",
				store: "session_turns",
				key,
				userKey,
				spaceId,
				sessionId,
				updatedAt: Date.now(),
			});
		});
	},

	subscribe(
		spaceId: string,
		sessionId: string,
		handler: (snapshot: SessionTurnsSnapshot) => void,
	) {
		ensureBroadcastSubscription();
		const listener = (
			snapshot: SessionTurnsSnapshot & { spaceId: string; sessionId: string },
		) => {
			if (snapshot.spaceId === spaceId && snapshot.sessionId === sessionId)
				handler(snapshot);
		};
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};
