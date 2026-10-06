import type { PaletteOverviewResponse } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "$lib/cache/broadcast";
import { getCacheUserKey } from "$lib/cache/keys";
import {
	canCommitPaletteOverviewRefresh,
	isUsablePaletteOverview,
} from "$lib/command-palette/palette-overview-cache-policy";
import {
	isOverviewSnapshotExpired,
	isOverviewSnapshotStale,
	shouldRevalidateOverview,
} from "$lib/command-palette/palette-overview-staleness";
import { sdk } from "$lib/sdk";
import { getRecentSpaces } from "$lib/stores/recent-space";

/**
 * Client cache for /api/palette/overview — the empty-query default list data.
 *
 * Memory + localStorage snapshot with a 60s freshness window. Viewer activity
 * records a user-scoped invalidation marker, and a debounced, throttled
 * background revalidation warms the snapshot afterwards, so the palette
 * usually opens straight from cache instead of fetching. Failures retain the
 * last-known-good snapshot and let the UI use its local fallback path.
 *
 * Both the snapshot and the throttle are shared across tabs: the snapshot and
 * the invalidation marker live in localStorage, and a successful refresh is
 * announced over the shared cache BroadcastChannel so other tabs adopt the
 * payload and extend their throttle without refetching it themselves.
 *
 * The throttle baseline is the snapshot's own commit time (plus this tab's
 * last attempt), so it needs no separate bookkeeping and stays consistent
 * with the other IndexedDB/localStorage caches.
 *
 * Freshness is not purely time-based: device-local activity (opening a Space)
 * is folded into the rendered list instead of invalidating the snapshot;
 * cross-device changes are picked up by the freshness window and the
 * foreground (focus / visibility) revalidation.
 */

const STORAGE_PREFIX = "cohub:palette-overview";
const INVALIDATION_STORAGE_PREFIX = "cohub:palette-overview-invalidated";
const CACHE_VERSION = 1;

type StoredOverview = PaletteOverviewResponse & { cachedAt: number };

type MemoryState = {
	userKey: string;
	snapshot: StoredOverview | null;
	/** Persisted so this and other tabs can observe viewer activity. */
	invalidatedAt: number;
	/** When the last refresh attempt started in this tab. */
	lastRefreshStartedAt: number;
	latestRequestId: number;
	inFlight: Promise<PaletteOverviewResponse | null> | null;
};

let memoryState: MemoryState | null = null;
let nextRequestId = 0;

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function storageKey(userKey: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userKey)}:v${CACHE_VERSION}`;
}

function invalidationStorageKey(userKey: string) {
	return `${INVALIDATION_STORAGE_PREFIX}:${encodeURIComponent(userKey)}:v${CACHE_VERSION}`;
}

function readInvalidatedAt(userKey: string) {
	if (!isBrowser()) return 0;
	try {
		const value = Number(
			localStorage.getItem(invalidationStorageKey(userKey)) ?? 0,
		);
		return Number.isFinite(value) && value > 0 ? value : 0;
	} catch {
		return 0;
	}
}

function safeParse(value: string | null): StoredOverview | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as StoredOverview;
		if (
			!parsed ||
			!Number.isFinite(parsed.cachedAt) ||
			!Array.isArray(parsed.spaces) ||
			!Array.isArray(parsed.recentSessions) ||
			parsed.degraded === true
		)
			return null;
		return parsed;
	} catch {
		return null;
	}
}

function readCached(userKey: string): StoredOverview | null {
	if (!isBrowser()) return null;
	try {
		const stored = safeParse(localStorage.getItem(storageKey(userKey)));
		if (!stored) return null;
		if (
			isOverviewSnapshotExpired({ cachedAt: stored.cachedAt, now: Date.now() })
		)
			return null;
		return stored;
	} catch {
		return null;
	}
}

function getMemoryState(userKey = getCacheUserKey()): MemoryState {
	ensureBroadcastSubscription();
	if (memoryState?.userKey === userKey) return memoryState;
	const snapshot = readCached(userKey);
	const invalidatedAt = readInvalidatedAt(userKey);
	memoryState = {
		userKey,
		snapshot,
		invalidatedAt,
		lastRefreshStartedAt: 0,
		latestRequestId: 0,
		inFlight: null,
	};
	return memoryState;
}

function syncPersistedInvalidation(state: MemoryState) {
	const persisted = readInvalidatedAt(state.userKey);
	if (persisted <= state.invalidatedAt) return;
	state.invalidatedAt = persisted;
}

/**
 * Adopt a snapshot another tab committed. The payload is shared through
 * localStorage, so a warm in one tab leaves every other tab warm too; without
 * this, a tab that warmed elsewhere would still render its own older snapshot
 * while the browser-wide throttle stops it from refetching.
 */
function syncPersistedSnapshot(state: MemoryState) {
	const persisted = readCached(state.userKey);
	if (!persisted) return;
	if (state.snapshot && persisted.cachedAt <= state.snapshot.cachedAt) return;
	state.snapshot = persisted;
}

/** Pull in anything other tabs have written before reading or deciding. */
function syncFromOtherTabs(state: MemoryState) {
	syncPersistedInvalidation(state);
	syncPersistedSnapshot(state);
}

/**
 * The throttle baseline: the later of this tab's last attempt and the
 * snapshot's commit time. The commit time is shared (localStorage), so a
 * refresh in any tab holds off every other tab; the per-tab attempt time
 * additionally bounds retries after a failure.
 */
function lastRefreshBaseline(state: MemoryState) {
	return Math.max(state.lastRefreshStartedAt, state.snapshot?.cachedAt ?? 0);
}

let subscribedToBroadcast = false;

/**
 * Adopt refreshes committed by other tabs as they happen. Same idea as the
 * other cache repos: the durable payload lives in storage, the shared cache
 * channel only announces it. This keeps a tab that is already running in
 * sync without polling storage.
 */
function ensureBroadcastSubscription() {
	if (subscribedToBroadcast) return;
	subscribedToBroadcast = true;
	subscribeCacheMessages((message) => {
		if (message.store !== "palette_overview") return;
		const state = memoryState;
		if (!state || state.userKey !== message.userKey) return;
		syncFromOtherTabs(state);
	});
}

export type PaletteOverviewSnapshot = {
	data: PaletteOverviewResponse | null;
	/** True when the next palette open must refetch before/at first render. */
	isStale: boolean;
};

export function getPaletteOverviewSnapshot(): PaletteOverviewSnapshot {
	const state = getMemoryState();
	syncFromOtherTabs(state);
	const snapshot = state.snapshot;
	if (!snapshot) return { data: null, isStale: true };
	return {
		data: snapshot,
		isStale: isOverviewSnapshotStale({
			cachedAt: snapshot.cachedAt,
			invalidatedAt: state.invalidatedAt,
			now: Date.now(),
		}),
	};
}

/**
 * Mark the overview cache as outdated after viewer activity (message sent,
 * session created, pin changed, ...). The refetch itself is deferred and
 * coalesced: a debounced background revalidation warms the snapshot so the
 * next palette open serves from cache instead of fetching, and the minimum
 * revalidate interval keeps a burst of activity from becoming a burst of
 * requests. Local-activity ordering is folded in at render time regardless.
 */
export function invalidatePaletteOverview() {
	const state = getMemoryState();
	syncPersistedInvalidation(state);
	state.invalidatedAt = Math.max(Date.now(), state.invalidatedAt + 1);
	if (!isBrowser()) return;
	try {
		localStorage.setItem(
			invalidationStorageKey(state.userKey),
			String(state.invalidatedAt),
		);
	} catch {
		// The in-memory timestamp still protects this tab.
	}
	schedulePaletteOverviewRevalidate();
}

export function clearCachedPaletteOverview() {
	cancelScheduledPaletteOverviewRevalidate();
	const userKey = getCacheUserKey();
	if (memoryState?.userKey === userKey) {
		// Invalidate in-flight writers before dropping the snapshot.
		memoryState.latestRequestId = ++nextRequestId;
		memoryState.inFlight = null;
		memoryState.snapshot = null;
		memoryState.invalidatedAt = 0;
	}
	if (!isBrowser()) return;
	try {
		localStorage.removeItem(storageKey(userKey));
		localStorage.removeItem(invalidationStorageKey(userKey));
	} catch {
		// Storage is best-effort.
	}
}

export function refreshPaletteOverview(options?: {
	signal?: AbortSignal;
}): Promise<PaletteOverviewResponse | null> {
	if (options?.signal?.aborted) return Promise.resolve(null);
	const userKey = getCacheUserKey();
	const state = getMemoryState(userKey);
	syncPersistedInvalidation(state);
	if (state.inFlight) return state.inFlight;

	const requestId = ++nextRequestId;
	state.latestRequestId = requestId;
	state.lastRefreshStartedAt = Date.now();
	const requestInvalidatedAt = state.invalidatedAt;
	const promise = (async (): Promise<PaletteOverviewResponse | null> => {
		try {
			const fetcher: typeof fetch = (input, init) =>
				fetch(input, { ...init, signal: options?.signal });
			const recentSpaces = getRecentSpaces(userKey).map((entry) => ({
				id: entry.spaceId,
				timestamp: entry.timestamp,
			}));
			const data = await sdk.search.overview(
				{ spaceLimit: 50, sessionLimit: 20, recentSpaces },
				fetcher,
			);
			// A response from another account, an older request, or before newer
			// viewer activity must never write memory or persistent storage.
			if (
				!canCommitPaletteOverviewRefresh({
					requestUserKey: userKey,
					currentUserKey: getCacheUserKey(),
					requestStateIsCurrent: memoryState === state,
					requestId,
					latestRequestId: state.latestRequestId,
					requestInvalidatedAt,
					currentInvalidatedAt: state.invalidatedAt,
					persistedInvalidatedAt: readInvalidatedAt(userKey),
				})
			)
				return null;
			if (!isUsablePaletteOverview(data)) return null;

			const stored: StoredOverview = { ...data, cachedAt: Date.now() };
			state.snapshot = stored;
			if (isBrowser()) {
				try {
					localStorage.setItem(storageKey(userKey), JSON.stringify(stored));
				} catch {
					// Quota failures are non-fatal; memory cache still applies.
				}
			}
			// Tell other tabs to adopt the payload and extend their throttle.
			publishCacheMessage({
				type: "cache-updated",
				store: "palette_overview",
				userKey,
				updatedAt: stored.cachedAt,
			});
			return data;
		} catch (error) {
			if ((error as { name?: string })?.name !== "AbortError")
				console.warn("[palette-overview] refresh failed", error);
			return null;
		}
	})();
	state.inFlight = promise;
	options?.signal?.addEventListener(
		"abort",
		() => {
			if (state.inFlight === promise) state.inFlight = null;
		},
		{ once: true },
	);
	void promise.then(
		() => {
			if (state.inFlight === promise) state.inFlight = null;
		},
		() => {
			if (state.inFlight === promise) state.inFlight = null;
		},
	);
	return promise;
}

const REVALIDATE_DEBOUNCE_MS = 1_500;
let revalidateTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Refresh the overview only when it can actually change what the palette
 * shows: skip when the snapshot is already fresh (local activity is folded in
 * at render time) and throttle bursts of invalidations.
 *
 * The throttle and the snapshot are shared across tabs, so an open in one tab
 * is served by a warm another tab already did.
 *
 * Resolves with the fresh payload only when a request was made, so callers do
 * not rebuild the list for a no-op.
 */
export function revalidatePaletteOverview(options?: {
	signal?: AbortSignal;
	force?: boolean;
}): Promise<PaletteOverviewResponse | null> {
	const state = getMemoryState();
	syncFromOtherTabs(state);
	const now = Date.now();
	const snapshot = state.snapshot;
	if (!options?.force && snapshot) {
		const stale = isOverviewSnapshotStale({
			cachedAt: snapshot.cachedAt,
			invalidatedAt: state.invalidatedAt,
			now,
		});
		if (!stale) return Promise.resolve(null);
		if (
			!shouldRevalidateOverview({
				lastRefreshStartedAt: lastRefreshBaseline(state),
				now,
			})
		)
			return Promise.resolve(null);
	}
	return refreshPaletteOverview(options);
}

/**
 * Coalesced background revalidation used outside the palette's open path
 * (viewer activity, tab focus / visibility). Coalescing plus the minimum
 * interval keeps a burst of activity from turning into a burst of requests.
 */
export function schedulePaletteOverviewRevalidate() {
	if (!isBrowser()) return;
	if (revalidateTimer != null) return;
	revalidateTimer = setTimeout(() => {
		revalidateTimer = null;
		void revalidatePaletteOverview();
	}, REVALIDATE_DEBOUNCE_MS);
}

/** Drop a pending background revalidation (logout / cache reset). */
export function cancelScheduledPaletteOverviewRevalidate() {
	if (revalidateTimer == null) return;
	clearTimeout(revalidateTimer);
	revalidateTimer = null;
}

/** Mark viewer activity; invalidation schedules a background revalidation. */
export function noteViewerActivity() {
	invalidatePaletteOverview();
}
