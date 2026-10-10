import type { SessionRecord, SessionTurnRecord } from "@neta-art/cohub";
import type { AccessState } from "$lib/access/access-state";
import { createRequestDedupe } from "$lib/features/space/modules/request-dedupe";
import { sessionStore } from "$lib/stores/session-store";

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
	let rawSessionStateById = $state.raw<Record<string, SessionViewState>>({});
	let activeSessionId = $state<string | null>(null);
	let loadingSessionIds = $state<Record<string, boolean>>({});
	let visibleInitialLoadingSessionIds = $state<Record<string, boolean>>({});
	let preloadingSessionIds = $state.raw(new Set<string>());
	const sessionLoadDedupe = createRequestDedupe();
	const syncSessionNewerDedupe = createRequestDedupe();
	const composed = new WeakMap<SessionViewState, SessionViewState>();

	function withStoredSession(id: string, state: SessionViewState) {
		const session = sessionStore.get(id);
		if (!session || session === state.session) return state;
		const cached = composed.get(state);
		if (cached?.session === session) return cached;
		const next = { ...state, session };
		composed.set(state, next);
		return next;
	}

	const sessionStateById = $derived.by(() => {
		const states: Record<string, SessionViewState> = {};
		for (const [id, state] of Object.entries(rawSessionStateById))
			states[id] = withStoredSession(id, state);
		return states;
	});

	function setSessionStates(next: Record<string, SessionViewState>) {
		const previous = rawSessionStateById;
		const current = sessionStateById;
		for (const [id, state] of Object.entries(next)) {
			if (state === previous[id] || state === current[id] || !state.session)
				continue;
			sessionStore.merge(state.session);
		}
		rawSessionStateById = next;
	}

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

	function prepareRouteSession(sessionId: string) {
		const existing = sessionStateById[sessionId];
		if (!existing) {
			setSessionStates({
				...sessionStateById,
				[sessionId]: initialSessionState(sessionStore.get(sessionId)),
			});
		} else if (
			!existing.loaded &&
			!existing.loading &&
			existing.turns.length === 0
		) {
			setSessionStates({
				...sessionStateById,
				[sessionId]: {
					...existing,
					loading: true,
				},
			});
		}
		activeSessionId = sessionId;
	}

	function setSessionState(sessionId: string, state: SessionViewState) {
		setSessionStates({ ...sessionStateById, [sessionId]: state });
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
		rawSessionStateById = {};
		activeSessionId = null;
		loadingSessionIds = {};
		visibleInitialLoadingSessionIds = {};
		resetInFlight();
	}

	return {
		get sessionStateById() {
			return sessionStateById;
		},
		set sessionStateById(value: Record<string, SessionViewState>) {
			setSessionStates(value);
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
