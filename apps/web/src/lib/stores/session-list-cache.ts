import type { SessionRecord } from "@neta-art/cohub";
import type { SessionListForkRecord } from "$lib/cache/db";
import { canUseUserScopedCache, getCacheUserKeyAsync } from "$lib/cache/keys";
import {
	type SessionListForksPatch,
	type SessionListIndexSnapshot,
	sessionListIndexRepo,
} from "$lib/cache/repositories/session-list-index-repo";
import {
	DEFAULT_SESSION_LIST_PAGE_INFO,
	type SessionListPageInfo,
} from "$lib/cache/types";
import { mergeSessionForks } from "$lib/session-fork-tree";
import { sessionStore } from "$lib/stores/session-store";

async function canUseCache() {
	return canUseUserScopedCache(await getCacheUserKeyAsync());
}

function canonical<T extends { sessions: SessionRecord[] }>(snapshot: T): T {
	return {
		...snapshot,
		sessions: sessionStore.seedAll(snapshot.sessions),
	};
}

export async function getCachedSessionListSnapshot(
	spaceId: string,
): Promise<SessionListIndexSnapshot | null> {
	if (!(await canUseCache())) return null;
	const snapshot = await sessionListIndexRepo
		.getRecent(spaceId)
		.catch((error) => {
			console.warn("[session-list-cache] Failed to read cached sessions", {
				spaceId,
				error,
			});
			return null;
		});
	return snapshot ? canonical(snapshot) : null;
}

export async function setCachedSessionList(
	spaceId: string,
	sessions: SessionRecord[],
	pageInfo?: SessionListPageInfo | null,
	forks?: SessionListForkRecord[] | null,
	options?: { mode?: "replace" | "merge" },
): Promise<SessionRecord[]> {
	const records = sessionStore.mergeAll(sessions);
	if (!(await canUseCache())) return records;
	// Details land before the index so its previews never replace them.
	await sessionStore.flush();
	const snapshot = await sessionListIndexRepo.setRecent(
		spaceId,
		records,
		pageInfo,
		forks,
		options,
	);
	return canonical(snapshot).sessions;
}

export async function patchCachedSessionList(
	spaceId: string,
	updater: (sessions: SessionRecord[]) => SessionRecord[],
	pageInfo?: SessionListPageInfo | null,
	forks?: SessionListForksPatch,
): Promise<SessionRecord[]> {
	const update = (sessions: SessionRecord[]) =>
		sessionStore.mergeAll(updater(sessionStore.seedAll(sessions)));
	if (!(await canUseCache())) {
		const current =
			(await getCachedSessionListSnapshot(spaceId))?.sessions ?? [];
		return update(current);
	}
	await sessionStore.flush();
	const snapshot = await sessionListIndexRepo.patchRecent(
		spaceId,
		update,
		pageInfo,
		forks,
	);
	return canonical(snapshot).sessions;
}

export async function listCachedSession(
	spaceId: string,
	session: SessionRecord,
	fork?: SessionListForkRecord | null,
) {
	if (!(await canUseCache())) return;
	if (!fork && (await sessionListIndexRepo.hasRecent(spaceId, session.id)))
		return;
	await patchCachedSessionList(
		spaceId,
		(current) =>
			current.some((item) => item.id === session.id)
				? current
				: [session, ...current],
		undefined,
		fork ? (forks) => mergeSessionForks(forks, [fork]) : undefined,
	);
}

export function onSessionListCacheUpdated(
	handler: (event: {
		spaceId: string;
		sessions: SessionRecord[];
		forks: SessionListForkRecord[];
		pageInfo: SessionListPageInfo | null;
	}) => void,
) {
	return sessionListIndexRepo.subscribeAll((spaceId, snapshot) =>
		handler({
			spaceId,
			sessions: sessionStore.seedAll(snapshot.sessions),
			forks: snapshot.forks,
			pageInfo: snapshot.pageInfo,
		}),
	);
}

type SessionListFetchResult = {
	sessions: SessionRecord[];
	forks?: SessionListForkRecord[] | null;
	pageInfo?: SessionListPageInfo | null;
};

const refreshInFlight = new Map<string, Promise<SessionRecord[]>>();

export function refreshCachedSessionList(
	spaceId: string,
	fetcher: () => Promise<SessionListFetchResult>,
): Promise<SessionRecord[]> {
	const pending = refreshInFlight.get(spaceId);
	if (pending) return pending;
	const run = (async () => {
		const result = await fetcher();
		return setCachedSessionList(
			spaceId,
			result.sessions,
			result.pageInfo ?? DEFAULT_SESSION_LIST_PAGE_INFO,
			result.forks,
		);
	})().finally(() => {
		if (refreshInFlight.get(spaceId) === run) refreshInFlight.delete(spaceId);
	});
	refreshInFlight.set(spaceId, run);
	return run;
}

export type { SessionListPageInfo };
