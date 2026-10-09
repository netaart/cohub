import type { SessionRecord, SessionTurnRecord } from "@neta-art/cohub";
import type { AccessState } from "$lib/access/access-state";
import { createRequestDedupe } from "$lib/features/space/modules/request-dedupe";
import { mergeSessionRecord } from "$lib/session-record-merge";
import { sortSessionsByRecentActivity } from "$lib/session-sort";

export type SessionViewState = {
	session: SessionRecord | undefined;
	turns: SessionTurnRecord[];
	loading: boolean;
	loaded: boolean;
	error: AccessState | null;
	hasMore: boolean;
	hasMoreNewer: boolean;
	loadingOlder: boolean;
	loadingNewer: boolean;
	oldestCursor: number | undefined;
};

export function createSessionWorkspaceController() {
	let spaceSessions = $state<SessionRecord[]>([]);
	let sessionStateById = $state<Record<string, SessionViewState>>({});
	let activeSessionId = $state<string | null>(null);
	let loadingSessionIds = $state<Record<string, boolean>>({});
	let visibleInitialLoadingSessionIds = $state<Record<string, boolean>>({});
	let preloadingSessionIds = $state.raw(new Set<string>());
	const sessionLoadDedupe = createRequestDedupe();
	const syncSessionNewerDedupe = createRequestDedupe();

	function initialSessionState(session?: SessionRecord): SessionViewState {
		return {
			session,
			turns: [],
			loading: true,
			loaded: false,
			error: null,
			hasMore: true,
			hasMoreNewer: false,
			loadingOlder: false,
			loadingNewer: false,
			oldestCursor: undefined,
		};
	}

	function upsertSessionRecord(session: SessionRecord) {
		const existingSession = spaceSessions.find(
			(item) => item.id === session.id,
		);
		const nextSessions = sortSessionsByRecentActivity([
			mergeSessionRecord(existingSession, session),
			...spaceSessions.filter((item) => item.id !== session.id),
		]);
		spaceSessions = nextSessions;
		const existing = sessionStateById[session.id];
		sessionStateById = {
			...sessionStateById,
			[session.id]: {
				session: mergeSessionRecord(existingSession, session),
				turns: existing?.turns ?? [],
				loading: existing?.loading ?? false,
				loaded: existing?.loaded ?? false,
				error: existing?.error ?? null,
				hasMore: existing?.hasMore ?? true,
				hasMoreNewer: existing?.hasMoreNewer ?? false,
				loadingOlder: existing?.loadingOlder ?? false,
				loadingNewer: existing?.loadingNewer ?? false,
				oldestCursor: existing?.oldestCursor,
			},
		};
		return nextSessions;
	}

	function applySessionRealtimeRecord(session: SessionRecord) {
		upsertSessionRecord(session);
	}

	function applySessionsSnapshot(sessions: SessionRecord[]) {
		const activeSession = activeSessionId
			? sessionStateById[activeSessionId]?.session
			: undefined;
		const nextSessions =
			activeSession &&
			!sessions.some((session) => session.id === activeSession.id)
				? sortSessionsByRecentActivity([activeSession, ...sessions])
				: sessions;
		spaceSessions = nextSessions;
		const nextState: Record<string, SessionViewState> = {};
		for (const session of nextSessions) {
			const existing = sessionStateById[session.id];
			nextState[session.id] = {
				session,
				turns: existing?.turns ?? [],
				loading: existing?.loading ?? false,
				loaded: existing?.loaded ?? false,
				error: existing?.error ?? null,
				hasMore: existing?.hasMore ?? true,
				hasMoreNewer: existing?.hasMoreNewer ?? false,
				loadingOlder: existing?.loadingOlder ?? false,
				loadingNewer: existing?.loadingNewer ?? false,
				oldestCursor: existing?.oldestCursor,
			};
		}
		if (
			activeSessionId &&
			sessionStateById[activeSessionId] &&
			!nextState[activeSessionId]
		) {
			nextState[activeSessionId] = sessionStateById[activeSessionId];
		}
		sessionStateById = nextState;
		return nextSessions;
	}

	function seedSessions(sessions: SessionRecord[]) {
		return applySessionsSnapshot(sessions);
	}

	function prepareRouteSession(sessionId: string) {
		const existing = sessionStateById[sessionId];
		if (!existing) {
			sessionStateById = {
				...sessionStateById,
				[sessionId]: initialSessionState(
					spaceSessions.find((session) => session.id === sessionId),
				),
			};
		} else if (
			!existing.loaded &&
			!existing.loading &&
			existing.turns.length === 0
		) {
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...existing,
					loading: true,
				},
			};
		}
		activeSessionId = sessionId;
	}

	function setSessionState(sessionId: string, state: SessionViewState) {
		sessionStateById = { ...sessionStateById, [sessionId]: state };
	}

	function patchSessionState(
		sessionId: string,
		updater: (current: SessionViewState | undefined) => SessionViewState,
	) {
		setSessionState(sessionId, updater(sessionStateById[sessionId]));
	}

	function runSessionLoad(sessionId: string, task: () => Promise<void>) {
		return sessionLoadDedupe.run(`session-load:${sessionId}`, task);
	}

	function runSyncSessionNewer(sessionId: string, task: () => Promise<void>) {
		return syncSessionNewerDedupe.run(`session-newer:${sessionId}`, task);
	}

	function isPreloadingSession(sessionId: string) {
		return preloadingSessionIds.has(sessionId);
	}

	function beginPreloadingSession(sessionId: string) {
		preloadingSessionIds = new Set(preloadingSessionIds).add(sessionId);
	}

	function endPreloadingSession(sessionId: string) {
		const next = new Set(preloadingSessionIds);
		next.delete(sessionId);
		preloadingSessionIds = next;
	}

	function resetInFlight() {
		sessionLoadDedupe.clear();
		syncSessionNewerDedupe.clear();
		preloadingSessionIds = new Set();
	}

	function reset() {
		spaceSessions = [];
		sessionStateById = {};
		activeSessionId = null;
		loadingSessionIds = {};
		visibleInitialLoadingSessionIds = {};
		resetInFlight();
	}

	return {
		get spaceSessions() {
			return spaceSessions;
		},
		set spaceSessions(value: SessionRecord[]) {
			spaceSessions = value;
		},
		get sessionStateById() {
			return sessionStateById;
		},
		set sessionStateById(value: Record<string, SessionViewState>) {
			sessionStateById = value;
		},
		get activeSessionId() {
			return activeSessionId;
		},
		set activeSessionId(value: string | null) {
			activeSessionId = value;
		},
		get loadingSessionIds() {
			return loadingSessionIds;
		},
		set loadingSessionIds(value: Record<string, boolean>) {
			loadingSessionIds = value;
		},
		get visibleInitialLoadingSessionIds() {
			return visibleInitialLoadingSessionIds;
		},
		set visibleInitialLoadingSessionIds(value: Record<string, boolean>) {
			visibleInitialLoadingSessionIds = value;
		},
		get preloadingSessionIds() {
			return preloadingSessionIds;
		},
		upsertSessionRecord,
		applySessionRealtimeRecord,
		applySessionsSnapshot,
		seedSessions,
		prepareRouteSession,
		setSessionState,
		patchSessionState,
		runSessionLoad,
		runSyncSessionNewer,
		isPreloadingSession,
		beginPreloadingSession,
		endPreloadingSession,
		resetInFlight,
		reset,
	};
}
