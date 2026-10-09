import type { PaletteOverviewResponse } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "$lib/cache/broadcast";
import { getCacheUserKey } from "$lib/cache/keys";
import { sdk } from "$lib/sdk";
import { getRecentSpaces } from "$lib/stores/recent-space";

/**
 * Client cache for /api/palette/overview: a memory + localStorage snapshot
 * shared across tabs. Viewer activity marks it stale and schedules a
 * throttled background refresh, so the palette usually opens from cache.
 */

const STORAGE_PREFIX = "cohub:palette-overview";
const INVALIDATION_STORAGE_PREFIX = "cohub:palette-overview-invalidated";
const CACHE_VERSION = 1;
const FRESH_MS = 60_000;
const HARD_EXPIRY_MS = 10 * 60_000;
const MIN_REVALIDATE_MS = 120_000;
const REVALIDATE_DEBOUNCE_MS = 1_500;

type StoredOverview = PaletteOverviewResponse & { cachedAt: number };

type MemoryState = {
	userKey: string;
	snapshot: StoredOverview | null;
	invalidatedAt: number;
	lastRefreshStartedAt: number;
	latestRequestId: number;
	inFlight: Promise<PaletteOverviewResponse | null> | null;
};

export type PaletteOverviewSnapshot = {
	data: PaletteOverviewResponse | null;
	isStale: boolean;
};

let memoryState: MemoryState | null = null;
let nextRequestId = 0;
let subscribedToBroadcast = false;
let revalidateTimer: ReturnType<typeof setTimeout> | null = null;

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function storageKey(userKey: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userKey)}:v${CACHE_VERSION}`;
}

function invalidationStorageKey(userKey: string) {
	return `${INVALIDATION_STORAGE_PREFIX}:${encodeURIComponent(userKey)}:v${CACHE_VERSION}`;
}

function isUsable(
	data: PaletteOverviewResponse | null,
): data is PaletteOverviewResponse {
	return Boolean(data && data.degraded !== true && Array.isArray(data.spaces));
}

function isStale(snapshot: StoredOverview, invalidatedAt: number, now: number) {
	return (
		invalidatedAt > snapshot.cachedAt || now - snapshot.cachedAt > FRESH_MS
	);
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

function readCached(userKey: string): StoredOverview | null {
	if (!isBrowser()) return null;
	try {
		const stored = JSON.parse(
			localStorage.getItem(storageKey(userKey)) ?? "null",
		) as StoredOverview | null;
		if (!isUsable(stored) || !Number.isFinite(stored.cachedAt)) return null;
		return Date.now() - stored.cachedAt > HARD_EXPIRY_MS ? null : stored;
	} catch {
		return null;
	}
}

function getMemoryState(userKey = getCacheUserKey()): MemoryState {
	ensureBroadcastSubscription();
	if (memoryState?.userKey === userKey) return memoryState;
	memoryState = {
		userKey,
		snapshot: readCached(userKey),
		invalidatedAt: readInvalidatedAt(userKey),
		lastRefreshStartedAt: 0,
		latestRequestId: 0,
		inFlight: null,
	};
	return memoryState;
}

function syncPersistedInvalidation(state: MemoryState) {
	state.invalidatedAt = Math.max(
		state.invalidatedAt,
		readInvalidatedAt(state.userKey),
	);
}

/** Pull in snapshots and invalidations other tabs have written. */
function syncFromOtherTabs(state: MemoryState) {
	syncPersistedInvalidation(state);
	const persisted = readCached(state.userKey);
	if (persisted && persisted.cachedAt > (state.snapshot?.cachedAt ?? 0))
		state.snapshot = persisted;
}

function ensureBroadcastSubscription() {
	if (subscribedToBroadcast) return;
	subscribedToBroadcast = true;
	subscribeCacheMessages((message) => {
		if (message.store !== "palette_overview") return;
		if (memoryState?.userKey === message.userKey)
			syncFromOtherTabs(memoryState);
	});
}

export function getPaletteOverviewSnapshot(): PaletteOverviewSnapshot {
	const state = getMemoryState();
	syncFromOtherTabs(state);
	const snapshot = state.snapshot;
	if (!snapshot) return { data: null, isStale: true };
	return {
		data: snapshot,
		isStale: isStale(snapshot, state.invalidatedAt, Date.now()),
	};
}

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
	} catch {}
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
	} catch {}
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
			const data = await sdk.search.overview(
				{
					spaceLimit: 50,
					recentSpaces: getRecentSpaces(userKey).map((entry) => ({
						id: entry.spaceId,
						timestamp: entry.timestamp,
					})),
				},
				(input, init) => fetch(input, { ...init, signal: options?.signal }),
			);
			// Never commit a response from another account, an older request,
			// or one that predates newer viewer activity.
			const current =
				memoryState === state &&
				getCacheUserKey() === userKey &&
				state.latestRequestId === requestId &&
				state.invalidatedAt === requestInvalidatedAt &&
				readInvalidatedAt(userKey) <= requestInvalidatedAt;
			if (!current || !isUsable(data)) return null;

			const stored: StoredOverview = { ...data, cachedAt: Date.now() };
			state.snapshot = stored;
			if (isBrowser()) {
				try {
					localStorage.setItem(storageKey(userKey), JSON.stringify(stored));
				} catch {}
			}
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
	const release = () => {
		if (state.inFlight === promise) state.inFlight = null;
	};
	state.inFlight = promise;
	options?.signal?.addEventListener("abort", release, { once: true });
	void promise.finally(release);
	return promise;
}

/**
 * Refresh only when the snapshot is stale and the shared throttle allows it.
 * Resolves with a payload only when a request was made.
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
		if (!isStale(snapshot, state.invalidatedAt, now))
			return Promise.resolve(null);
		const lastRefresh = Math.max(state.lastRefreshStartedAt, snapshot.cachedAt);
		if (now - lastRefresh < MIN_REVALIDATE_MS) return Promise.resolve(null);
	}
	return refreshPaletteOverview(options);
}

export function schedulePaletteOverviewRevalidate() {
	if (!isBrowser() || revalidateTimer != null) return;
	revalidateTimer = setTimeout(() => {
		revalidateTimer = null;
		void revalidatePaletteOverview();
	}, REVALIDATE_DEBOUNCE_MS);
}

export function cancelScheduledPaletteOverviewRevalidate() {
	if (revalidateTimer == null) return;
	clearTimeout(revalidateTimer);
	revalidateTimer = null;
}

export function noteViewerActivity() {
	invalidatePaletteOverview();
}
