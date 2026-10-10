import type { SessionRecord } from "@neta-art/cohub";
import { canUseUserScopedCache, getCacheUserKeyAsync } from "$lib/cache/keys";
import { sessionDetailRepo } from "$lib/cache/repositories/session-detail-repo";
import { sessionTurnsRepo } from "$lib/cache/repositories/session-turns-repo";
import { mergeSessionRecord } from "$lib/session-record-merge";
import { sessionStore } from "$lib/stores/session-store";

const refreshInFlight = new Map<string, Promise<SessionRecord>>();

async function canUseCache() {
	return canUseUserScopedCache(await getCacheUserKeyAsync());
}

export async function findCachedSession(
	sessionId: string,
): Promise<{ spaceId: string; session: SessionRecord } | null> {
	const known = sessionStore.get(sessionId);
	if (known) return { spaceId: known.spaceId, session: known };
	if (!(await canUseCache())) return null;
	const [detail, turns] = await Promise.all([
		sessionDetailRepo.find(sessionId).catch(() => null),
		sessionTurnsRepo.find(sessionId).catch(() => null),
	]);
	const cached = [detail?.session, turns?.session].filter(
		(session): session is SessionRecord => Boolean(session),
	);
	if (cached.length === 0) return null;
	const session = sessionStore.seed(cached.reduce(mergeSessionRecord));
	return { spaceId: session.spaceId, session };
}

export async function forgetCachedSession(spaceId: string, sessionId: string) {
	sessionStore.forget(sessionId);
	if (!(await canUseCache())) return;
	await Promise.all([
		sessionDetailRepo.delete(spaceId, sessionId),
		sessionTurnsRepo.clearSession(spaceId, sessionId),
	]);
}

function refreshSessionDetail(
	sessionId: string,
	fetcher: () => Promise<SessionRecord>,
) {
	const pending = refreshInFlight.get(sessionId);
	if (pending) return pending;
	const run = fetcher()
		.then((session) => sessionStore.merge(session))
		.finally(() => {
			if (refreshInFlight.get(sessionId) === run)
				refreshInFlight.delete(sessionId);
		});
	refreshInFlight.set(sessionId, run);
	return run;
}

export async function fetchSessionDetailWithCache(
	spaceId: string,
	sessionId: string,
	fetcher: () => Promise<SessionRecord>,
	options?: { force?: boolean },
): Promise<SessionRecord> {
	if (options?.force || !(await canUseCache()))
		return refreshSessionDetail(sessionId, fetcher);
	const cached = await sessionDetailRepo
		.get(spaceId, sessionId)
		.catch(() => null);
	if (!cached) return refreshSessionDetail(sessionId, fetcher);
	if (cached.stale)
		void refreshSessionDetail(sessionId, fetcher).catch(() => undefined);
	return sessionStore.seed(cached.session);
}
