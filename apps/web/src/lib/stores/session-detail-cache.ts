import type { SessionRecord } from "@neta-art/cohub";
import { canUseUserScopedCache, getCacheUserKeyAsync } from "$lib/cache/keys";
import { sessionDetailRepo } from "$lib/cache/repositories/session-detail-repo";
import { sessionTurnsRepo } from "$lib/cache/repositories/session-turns-repo";

const refreshInFlight = new Map<string, Promise<SessionRecord>>();

function cacheKey(spaceId: string, sessionId: string) {
	return `${spaceId}:${sessionId}`;
}

async function resolveCacheUserKey() {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey) ? userKey : null;
}

export async function getCachedSessionDetailSnapshot(
	spaceId: string,
	sessionId: string,
) {
	if (!(await resolveCacheUserKey())) return null;
	return sessionDetailRepo.get(spaceId, sessionId);
}

export async function findCachedSession(
	sessionId: string,
): Promise<{ spaceId: string; session: SessionRecord } | null> {
	if (!(await resolveCacheUserKey())) return null;
	const [detail, turns] = await Promise.all([
		sessionDetailRepo.find(sessionId).catch(() => null),
		sessionTurnsRepo.find(sessionId).catch(() => null),
	]);
	let newest: {
		spaceId: string;
		session: SessionRecord;
		updatedAt: number;
	} | null = detail;
	if (turns?.session && (!newest || turns.updatedAt > newest.updatedAt))
		newest = { ...turns, session: turns.session };
	return newest ? { spaceId: newest.spaceId, session: newest.session } : null;
}

export async function forgetCachedSession(spaceId: string, sessionId: string) {
	if (!(await resolveCacheUserKey())) return;
	await Promise.all([
		sessionDetailRepo.delete(spaceId, sessionId),
		sessionTurnsRepo.clearSession(spaceId, sessionId),
	]);
}

export async function getCachedSessionDetails(
	spaceId: string,
	sessionIds: string[],
) {
	if (!(await resolveCacheUserKey())) return {};
	return sessionDetailRepo.getMany(spaceId, sessionIds);
}

export async function setCachedSessionDetail(
	spaceId: string,
	session: SessionRecord,
) {
	if (!(await resolveCacheUserKey())) return null;
	return sessionDetailRepo.set(spaceId, session);
}

export async function setCachedSessionDetails(
	spaceId: string,
	sessions: SessionRecord[],
) {
	if (!(await resolveCacheUserKey())) return [];
	return sessionDetailRepo.setMany(spaceId, sessions);
}

export async function fetchSessionDetailWithCache(
	spaceId: string,
	sessionId: string,
	fetcher: () => Promise<SessionRecord>,
	options?: { force?: boolean },
): Promise<SessionRecord> {
	await getCacheUserKeyAsync();
	const canCache = Boolean(await resolveCacheUserKey());
	const cached =
		canCache && !options?.force
			? await sessionDetailRepo.get(spaceId, sessionId).catch(() => null)
			: null;
	if (cached) {
		if (cached.stale) {
			void sessionDetailRepo
				.refresh(spaceId, sessionId, fetcher)
				.catch(() => undefined);
		}
		return cached.session;
	}

	if (!canCache) return fetcher();

	const key = cacheKey(spaceId, sessionId);
	const pending = refreshInFlight.get(key);
	if (pending) return pending;
	const run = sessionDetailRepo
		.refresh(spaceId, sessionId, fetcher)
		.then((snapshot) => snapshot.session)
		.finally(() => {
			if (refreshInFlight.get(key) === run) refreshInFlight.delete(key);
		});
	refreshInFlight.set(key, run);
	return run;
}

export function onSessionDetailCacheUpdated(
	spaceId: string,
	sessionId: string,
	handler: (session: SessionRecord) => void,
) {
	return sessionDetailRepo.subscribe(spaceId, sessionId, (snapshot) => {
		handler(snapshot.session);
	});
}
