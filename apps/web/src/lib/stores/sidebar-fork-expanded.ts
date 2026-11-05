import { getCacheUserKey } from "$lib/cache/keys";

const VERSION = 1;
const PREFIX = "cohub:sidebar-forks-collapsed";

// Fork groups default to expanded, so only collapsed parents are stored.
type CollapsedForksCache = {
	version: typeof VERSION;
	userKey: string;
	spaceId: string;
	collapsedSessionIds: string[];
	updatedAt: number;
};

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function storageKey(spaceId: string) {
	return `${PREFIX}:${encodeURIComponent(getCacheUserKey())}:${encodeURIComponent(spaceId)}:v${VERSION}`;
}

export function getCachedCollapsedForkIds(spaceId: string): Set<string> {
	if (!isBrowser()) return new Set();
	try {
		const raw = localStorage.getItem(storageKey(spaceId));
		if (!raw) return new Set();
		const parsed = JSON.parse(raw) as CollapsedForksCache;
		if (
			parsed.version !== VERSION ||
			parsed.userKey !== getCacheUserKey() ||
			parsed.spaceId !== spaceId ||
			!Array.isArray(parsed.collapsedSessionIds)
		) {
			return new Set();
		}
		return new Set(
			parsed.collapsedSessionIds.filter((id) => typeof id === "string" && id),
		);
	} catch {
		return new Set();
	}
}

export function setCachedCollapsedForkIds(
	spaceId: string,
	collapsedSessionIds: ReadonlySet<string>,
) {
	if (!isBrowser()) return;
	try {
		const key = storageKey(spaceId);
		if (collapsedSessionIds.size === 0) {
			localStorage.removeItem(key);
			return;
		}
		const data: CollapsedForksCache = {
			version: VERSION,
			userKey: getCacheUserKey(),
			spaceId,
			collapsedSessionIds: [...collapsedSessionIds],
			updatedAt: Date.now(),
		};
		localStorage.setItem(key, JSON.stringify(data));
	} catch {
		// localStorage may be unavailable or full; runtime state remains authoritative.
	}
}
