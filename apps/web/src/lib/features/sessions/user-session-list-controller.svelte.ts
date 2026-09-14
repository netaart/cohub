import type {
	ChannelEnvelope,
	UserSessionListItem,
	UserSessionSourceFilter,
} from "@neta-art/cohub";
import { getCacheUserKeyAsync } from "$lib/cache/keys";
import { sdk } from "$lib/sdk";
import { mergeSessionRecord } from "$lib/session-record-merge";
import { sortSessionsByRecentActivity } from "$lib/session-sort";
import { reconcileGenerationStateFromSessionList } from "$lib/stores/session-generation-list-reconcile";
import {
	emptyUserSessionListPageInfo,
	getCachedUserSessionListSnapshot,
	onUserSessionListCacheUpdated,
	setCachedUserSessionList,
} from "$lib/stores/user-session-list-cache";

const PAGE_SIZE = 30;
/** Coalesce bursty turn.notify events into one list refresh. */
const REALTIME_REFRESH_DEBOUNCE_MS = 400;

type TurnNotifyPayload = {
	spaceId?: unknown;
	sessionId?: unknown;
	userPreview?: unknown;
	completedAt?: unknown;
};

function isTurnNotifyEvent(
	event: ChannelEnvelope,
): event is ChannelEnvelope & { payload: TurnNotifyPayload } {
	if (event.type !== "session.turn.notify") return false;
	const payload = event.payload as TurnNotifyPayload;
	return (
		typeof payload.sessionId === "string" && typeof payload.spaceId === "string"
	);
}

export function createUserSessionListController(input?: {
	source?: UserSessionSourceFilter | null;
}) {
	let source = $state<UserSessionSourceFilter | null>(input?.source ?? null);
	let sessions = $state<UserSessionListItem[]>([]);
	let pageInfo = $state(emptyUserSessionListPageInfo());
	let loading = $state(false);
	let loadingMore = $state(false);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let hydrated = $state(false);
	let refreshSeq = 0;
	let loadMoreSeq = 0;
	let realtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let stopRealtime: (() => void) | null = null;

	function applySnapshot(
		next: {
			sessions: UserSessionListItem[];
			pageInfo?: { hasMore: boolean; nextCursor: string | null } | null;
		},
		options?: { authoritative?: boolean; requestStartedAt?: number },
	) {
		sessions = sortSessionsByRecentActivity(
			next.sessions,
		) as UserSessionListItem[];
		reconcileGenerationStateFromSessionList(sessions, options);
		if (next.pageInfo) {
			pageInfo = {
				hasMore: Boolean(next.pageInfo.hasMore),
				nextCursor: next.pageInfo.nextCursor ?? null,
			};
		}
	}

	async function hydrateFromCache() {
		const cached = await getCachedUserSessionListSnapshot().catch(() => null);
		if (cached?.sessions.length) {
			applySnapshot(cached);
		}
		hydrated = true;
		return cached;
	}

	async function refresh(options?: { force?: boolean }) {
		if (refreshing && !options?.force) return;
		const seq = ++refreshSeq;
		const requestSource = source;
		const requestUserKey = await getCacheUserKeyAsync();
		const shouldShowLoading = sessions.length === 0;
		if (shouldShowLoading) loading = true;
		else refreshing = true;
		error = null;
		try {
			const requestStartedAt = Date.now();
			const result = await sdk.user.listSessions({
				limit: PAGE_SIZE,
				cursor: null,
				source: requestSource,
			});
			if (seq !== refreshSeq) return;
			const currentUserKey = await getCacheUserKeyAsync();
			if (currentUserKey !== requestUserKey) return;

			const nextSessions = (result.sessions ?? []) as UserSessionListItem[];
			const nextPageInfo = result.pageInfo ?? emptyUserSessionListPageInfo();
			applySnapshot(
				{ sessions: nextSessions, pageInfo: nextPageInfo },
				{ authoritative: true, requestStartedAt },
			);
			await setCachedUserSessionList(nextSessions, nextPageInfo, {
				mode: "replace",
				expectedUserKey: requestUserKey,
			});
		} catch (err) {
			if (seq !== refreshSeq) return;
			console.warn("[user-sessions] Failed to refresh list", err);
			if (sessions.length === 0) {
				error = err instanceof Error ? err.message : "Failed to load sessions";
			}
		} finally {
			if (seq === refreshSeq) {
				loading = false;
				refreshing = false;
				hydrated = true;
			}
		}
	}

	async function loadMore() {
		if (loadingMore || !pageInfo.hasMore || !pageInfo.nextCursor) return;
		const seq = ++loadMoreSeq;
		const requestSource = source;
		const requestUserKey = await getCacheUserKeyAsync();
		const cursor = pageInfo.nextCursor;
		loadingMore = true;
		error = null;
		try {
			const requestStartedAt = Date.now();
			const result = await sdk.user.listSessions({
				limit: PAGE_SIZE,
				cursor,
				source: requestSource,
			});
			if (seq !== loadMoreSeq) return;
			const currentUserKey = await getCacheUserKeyAsync();
			if (currentUserKey !== requestUserKey) return;

			const more = (result.sessions ?? []) as UserSessionListItem[];
			const nextPageInfo = result.pageInfo ?? emptyUserSessionListPageInfo();
			const byId = new Map(sessions.map((session) => [session.id, session]));
			for (const session of more) {
				byId.set(
					session.id,
					mergeSessionRecord(
						byId.get(session.id),
						session,
					) as UserSessionListItem,
				);
			}
			const merged = sortSessionsByRecentActivity([
				...byId.values(),
			]) as UserSessionListItem[];
			applySnapshot(
				{ sessions: merged, pageInfo: nextPageInfo },
				{ authoritative: true, requestStartedAt },
			);
			await setCachedUserSessionList(merged, nextPageInfo, {
				mode: "replace",
				expectedUserKey: requestUserKey,
			});
		} catch (err) {
			if (seq !== loadMoreSeq) return;
			console.warn("[user-sessions] Failed to load more", err);
		} finally {
			if (seq === loadMoreSeq) loadingMore = false;
		}
	}

	function upsertSession(session: UserSessionListItem) {
		const existing = sessions.find((item) => item.id === session.id);
		const next = sortSessionsByRecentActivity([
			mergeSessionRecord(existing, session) as UserSessionListItem,
			...sessions.filter((item) => item.id !== session.id),
		]) as UserSessionListItem[];
		sessions = next;
		void setCachedUserSessionList(next, pageInfo, { mode: "replace" });
	}

	function findById(sessionId: string) {
		return sessions.find((session) => session.id === sessionId) ?? null;
	}

	/**
	 * Switch the server-side filter. Drops the current page set and invalidates
	 * in-flight requests; the next refresh walks matching rows only.
	 */
	async function setSource(next: UserSessionSourceFilter | null) {
		if (next === source) return;
		source = next;
		refreshSeq += 1;
		loadMoreSeq += 1;
		sessions = [];
		pageInfo = emptyUserSessionListPageInfo();
		loading = false;
		loadingMore = false;
		refreshing = false;
		error = null;
		await refresh({ force: true });
	}

	function scheduleRealtimeRefresh() {
		if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
		realtimeRefreshTimer = setTimeout(() => {
			realtimeRefreshTimer = null;
			void refresh({ force: true });
		}, REALTIME_REFRESH_DEBOUNCE_MS);
	}

	/**
	 * User-room `session.turn.notify` already powers turn toasts.
	 * Reuse it to keep the cross-space chats list warm without extra channels.
	 */
	function handleRealtimeEvent(event: ChannelEnvelope) {
		if (!isTurnNotifyEvent(event)) return;
		const sessionId = event.payload.sessionId as string;
		const spaceId = event.payload.spaceId as string;
		const preview =
			typeof event.payload.userPreview === "string"
				? event.payload.userPreview
				: null;
		const completedAt =
			typeof event.payload.completedAt === "string"
				? event.payload.completedAt
				: new Date().toISOString();

		const existing = findById(sessionId);
		if (existing) {
			upsertSession({
				...existing,
				spaceId: existing.spaceId || spaceId,
				latestMessageText: preview ?? existing.latestMessageText,
				lastMessageAt: completedAt,
				updatedAt: completedAt,
			});
		}
		// Always reconcile with server so unknown / participant sessions appear.
		scheduleRealtimeRefresh();
	}

	function subscribeCache() {
		return onUserSessionListCacheUpdated((snapshot) => {
			applySnapshot(snapshot);
		});
	}

	function subscribeRealtime() {
		stopRealtime?.();
		stopRealtime = sdk.onUserEvent((event) => handleRealtimeEvent(event));
		return () => {
			stopRealtime?.();
			stopRealtime = null;
			if (realtimeRefreshTimer) {
				clearTimeout(realtimeRefreshTimer);
				realtimeRefreshTimer = null;
			}
		};
	}

	return {
		get source() {
			return source;
		},
		get sessions() {
			return sessions;
		},
		get pageInfo() {
			return pageInfo;
		},
		get loading() {
			return loading;
		},
		get loadingMore() {
			return loadingMore;
		},
		get refreshing() {
			return refreshing;
		},
		get error() {
			return error;
		},
		get hydrated() {
			return hydrated;
		},
		hydrateFromCache,
		refresh,
		loadMore,
		upsertSession,
		findById,
		setSource,
		subscribeCache,
		subscribeRealtime,
	};
}
