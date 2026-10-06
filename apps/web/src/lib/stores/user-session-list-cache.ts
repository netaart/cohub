import type { UserSessionListItem } from "@neta-art/cohub";
import type { SessionListForkRecord } from "$lib/cache/db";
import { idbGet, idbPut } from "$lib/cache/db";
import {
	canUseUserScopedCache,
	getCacheUserKeyAsync,
	userSessionListKey,
} from "$lib/cache/keys";
import {
	DEFAULT_SESSION_LIST_PAGE_INFO,
	type SessionListPageInfo,
} from "$lib/cache/types";
import { mergeSessionRecords } from "$lib/session-record-merge";
import { sortSessionsByRecentActivity } from "$lib/session-sort";

const STORE = "session_lists" as const;
const TTL_MS = 30_000;

type UserSessionListCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	kind: "recent";
	sessions: UserSessionListItem[];
	forks?: SessionListForkRecord[];
	pageInfo: SessionListPageInfo;
	updatedAt: number;
	lastAccessedAt: number;
	watermark: string | null;
	completeness: "partial" | "complete";
};

export type UserSessionListSnapshot = {
	sessions: UserSessionListItem[];
	forks: SessionListForkRecord[];
	pageInfo: SessionListPageInfo;
	updatedAt: number;
	stale: boolean;
};

const memory = new Map<string, UserSessionListCacheRecord>();

function normalizeSessions(sessions: UserSessionListItem[]) {
	return sortSessionsByRecentActivity(
		mergeSessionRecords(sessions),
	) as UserSessionListItem[];
}

function normalizePageInfo(
	pageInfo?: SessionListPageInfo | null,
): SessionListPageInfo {
	return {
		hasMore: Boolean(pageInfo?.hasMore),
		nextCursor: pageInfo?.nextCursor ?? null,
	};
}

function toSnapshot(
	record: UserSessionListCacheRecord,
): UserSessionListSnapshot {
	return {
		sessions: record.sessions,
		forks: record.forks ?? [],
		pageInfo: record.pageInfo,
		updatedAt: record.updatedAt,
		stale: Date.now() - record.updatedAt > TTL_MS,
	};
}

async function resolveKey(scope: string) {
	const userKey = await getCacheUserKeyAsync();
	if (!canUseUserScopedCache(userKey)) return null;
	return { userKey, key: userSessionListKey(userKey, scope) };
}

export async function getCachedUserSessionListSnapshot(
	scope: string,
): Promise<UserSessionListSnapshot | null> {
	const resolved = await resolveKey(scope);
	if (!resolved) return null;

	const memoryHit = memory.get(resolved.key);
	if (memoryHit) return toSnapshot(memoryHit);

	try {
		const record = await idbGet<UserSessionListCacheRecord>(
			STORE,
			resolved.key,
		);
		if (!record) return null;
		memory.set(resolved.key, record);
		return toSnapshot(record);
	} catch (error) {
		console.warn("[user-session-list-cache] Failed to read cache", error);
		return null;
	}
}

export async function setCachedUserSessionList(
	scope: string,
	sessions: UserSessionListItem[],
	pageInfo?: SessionListPageInfo | null,
	options?: {
		expectedUserKey?: string | null;
		forks?: SessionListForkRecord[];
	},
): Promise<void> {
	const resolved = await resolveKey(scope);
	if (!resolved) return;
	// Drop stale writes if the signed-in user changed mid-flight.
	if (options?.expectedUserKey && options.expectedUserKey !== resolved.userKey)
		return;

	const current = memory.get(resolved.key) ?? null;
	const nextSessions = normalizeSessions(sessions);
	const now = Date.now();
	const record: UserSessionListCacheRecord = {
		key: resolved.key,
		userKey: resolved.userKey,
		// Reuse the space-scoped store schema with a sentinel space id.
		spaceId: "__user__",
		kind: "recent",
		sessions: nextSessions,
		forks: options?.forks ?? current?.forks ?? [],
		pageInfo: normalizePageInfo(pageInfo ?? current?.pageInfo),
		updatedAt: now,
		lastAccessedAt: now,
		watermark: nextSessions[0]?.lastMessageAt ?? null,
		completeness: pageInfo?.hasMore ? "partial" : "complete",
	};

	memory.set(resolved.key, record);
	await idbPut(STORE, record).catch((error) => {
		console.warn("[user-session-list-cache] Failed to write cache", error);
	});
}

export function emptyUserSessionListPageInfo(): SessionListPageInfo {
	return { ...DEFAULT_SESSION_LIST_PAGE_INFO };
}
