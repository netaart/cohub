import type { SessionRecord } from "@neta-art/cohub";
import type { SessionListForkRecord } from "$lib/cache/db";
import { deleteCacheDatabase } from "$lib/cache/db";
import { canUseUserScopedCache, getCacheUserKeyAsync } from "$lib/cache/keys";
import {
	type SessionListForksPatch,
	sessionListIndexRepo,
} from "$lib/cache/repositories/session-list-index-repo";
import {
	DEFAULT_SESSION_LIST_PAGE_INFO,
	type SessionListPageInfo,
} from "$lib/cache/types";

async function resolveCacheUserKey() {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey) ? userKey : null;
}

export function getCachedSessionList(spaceId: string): SessionRecord[] | null {
	void spaceId;
	return null;
}

export function getCachedSessionListPageInfo(
	spaceId: string,
): SessionListPageInfo | null {
	void spaceId;
	return null;
}

export function getCachedSessionListMeta(spaceId: string) {
	void spaceId;
	return null;
}

export async function getCachedSessionListSnapshot(spaceId: string) {
	if (!(await resolveCacheUserKey())) return null;
	return sessionListIndexRepo.getRecent(spaceId).catch((error) => {
		console.warn("[session-list-cache] Failed to read cached sessions", {
			spaceId,
			error,
		});
		return null;
	});
}

export async function setCachedSessionList(
	spaceId: string,
	sessions: SessionRecord[],
	pageInfo?: SessionListPageInfo | null,
	forks?: SessionListForkRecord[] | null,
	options?: { mode?: "replace" | "merge" },
): Promise<SessionRecord[]> {
	if (!(await resolveCacheUserKey())) return sessions;
	const snapshot = await sessionListIndexRepo.setRecent(
		spaceId,
		sessions,
		pageInfo,
		forks,
		options,
	);
	return snapshot.sessions;
}

export async function patchCachedSessionList(
	spaceId: string,
	updater: (sessions: SessionRecord[]) => SessionRecord[],
	pageInfo?: SessionListPageInfo | null,
	forks?: SessionListForksPatch,
): Promise<SessionRecord[]> {
	if (!(await resolveCacheUserKey())) {
		const current =
			(await getCachedSessionListSnapshot(spaceId))?.sessions ?? [];
		return updater(current);
	}
	const snapshot = await sessionListIndexRepo.patchRecent(
		spaceId,
		updater,
		pageInfo,
		forks,
	);
	return snapshot.sessions;
}

export async function clearCachedSessionList(spaceId: string) {
	if (!(await resolveCacheUserKey())) return;
	await sessionListIndexRepo.deleteRecent(spaceId);
}

export async function clearAllCachedSessionLists() {
	await deleteCacheDatabase();
}

export function onSessionListCacheUpdated(
	handler: (event: {
		spaceId: string;
		sessions: SessionRecord[];
		forks: SessionListForkRecord[];
		pageInfo: SessionListPageInfo | null;
	}) => void,
) {
	const unsubscribers = new Map<string, () => void>();
	// Compatibility event stream is now driven by repository broadcasts. Since the
	// old API was global-by-space, expose a lightweight DOM bridge below.
	const listener = (event: Event) => {
		const custom = event as CustomEvent<{
			spaceId: string;
			sessions: SessionRecord[];
			forks?: SessionListForkRecord[];
			pageInfo: SessionListPageInfo;
		}>;
		if (!custom.detail?.spaceId) return;
		handler({
			...custom.detail,
			forks: custom.detail.forks ?? [],
			pageInfo: custom.detail.pageInfo,
		});
	};
	if (typeof window !== "undefined")
		window.addEventListener("cohub:session-list-cache-updated", listener);
	return () => {
		for (const unsubscribe of unsubscribers.values()) unsubscribe();
		if (typeof window !== "undefined")
			window.removeEventListener("cohub:session-list-cache-updated", listener);
	};
}

type SessionListCacheFetchResult =
	| SessionRecord[]
	| {
			sessions: SessionRecord[];
			forks?: SessionListForkRecord[] | null;
			pageInfo?: SessionListPageInfo | null;
	  };

function normalizeSessionListFetchResult(result: SessionListCacheFetchResult): {
	sessions: SessionRecord[];
	forks?: SessionListForkRecord[] | null;
	pageInfo?: SessionListPageInfo | null;
} {
	return Array.isArray(result) ? { sessions: result } : result;
}

const sessionListRefreshInFlight = new Map<string, Promise<SessionRecord[]>>();

function refreshSessionListCache(
	spaceId: string,
	fetcher: () => Promise<SessionListCacheFetchResult>,
	onRefresh?: (sessions: SessionRecord[]) => void,
): Promise<SessionRecord[]> {
	const inFlight = sessionListRefreshInFlight.get(spaceId);
	if (inFlight) {
		return inFlight.then((sessions) => {
			onRefresh?.(sessions);
			return sessions;
		});
	}

	const run = (async () => {
		await getCacheUserKeyAsync();
		const result = normalizeSessionListFetchResult(await fetcher());
		const sessions = result.sessions;
		if (!(await resolveCacheUserKey())) return sessions;
		const snapshot = await sessionListIndexRepo.setRecent(
			spaceId,
			sessions,
			result.pageInfo ?? DEFAULT_SESSION_LIST_PAGE_INFO,
			result.forks,
		);
		onRefresh?.(snapshot.sessions);
		return snapshot.sessions;
	})().finally(() => {
		if (sessionListRefreshInFlight.get(spaceId) === run) {
			sessionListRefreshInFlight.delete(spaceId);
		}
	});

	sessionListRefreshInFlight.set(spaceId, run);
	return run;
}

export async function fetchSessionListWithCache(
	spaceId: string,
	fetcher: () => Promise<SessionListCacheFetchResult>,
	options?: {
		force?: boolean;
		onBackgroundRefresh?: (sessions: SessionRecord[]) => void;
	},
): Promise<SessionRecord[]> {
	const cached = !options?.force
		? await getCachedSessionListSnapshot(spaceId).catch(() => null)
		: null;
	if (cached) {
		void refreshSessionListCache(
			spaceId,
			fetcher,
			options?.onBackgroundRefresh,
		).catch(() => undefined);
		return cached.sessions;
	}
	return refreshSessionListCache(
		spaceId,
		fetcher,
		options?.onBackgroundRefresh,
	);
}

export async function fetchSessionListWithPageInfoCache(
	spaceId: string,
	fetcher: () => Promise<{
		sessions: SessionRecord[];
		pageInfo?: SessionListPageInfo;
	}>,
	_options?: { force?: boolean },
): Promise<{ sessions: SessionRecord[]; pageInfo: SessionListPageInfo }> {
	await getCacheUserKeyAsync();
	const result = await fetcher();
	const pageInfo = result.pageInfo ?? DEFAULT_SESSION_LIST_PAGE_INFO;
	if (!(await resolveCacheUserKey())) {
		return { sessions: result.sessions, pageInfo };
	}
	const snapshot = await sessionListIndexRepo.patchRecent(
		spaceId,
		() => result.sessions,
		pageInfo,
	);
	return { sessions: snapshot.sessions, pageInfo: snapshot.pageInfo };
}

export type { SessionListPageInfo };
