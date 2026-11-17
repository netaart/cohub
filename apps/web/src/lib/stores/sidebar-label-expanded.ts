import { getCacheUserKey } from "#lib/cache/keys.ts";

const VERSION = 1;
const PREFIX = "cohub:sidebar-labels-expanded";

type ExpandedLabelsCache = {
	version: typeof VERSION;
	userKey: string;
	spaceId: string;
	expandedLabelIds: string[];
	updatedAt: number;
};

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function storageKey(spaceId: string) {
	return `${PREFIX}:${encodeURIComponent(getCacheUserKey())}:${encodeURIComponent(spaceId)}:v${VERSION}`;
}

export function getCachedExpandedLabelIdsSnapshot(
	spaceId: string,
): Set<string> | null {
	if (!isBrowser()) return null;
	try {
		const raw = localStorage.getItem(storageKey(spaceId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as ExpandedLabelsCache;
		if (
			parsed.version !== VERSION ||
			parsed.userKey !== getCacheUserKey() ||
			parsed.spaceId !== spaceId ||
			!Array.isArray(parsed.expandedLabelIds)
		) {
			return null;
		}
		return new Set(
			parsed.expandedLabelIds.filter((id) => typeof id === "string" && id),
		);
	} catch {
		return null;
	}
}

export function getCachedExpandedLabelIds(spaceId: string): Set<string> {
	return getCachedExpandedLabelIdsSnapshot(spaceId) ?? new Set();
}

export function setCachedExpandedLabelIds(
	spaceId: string,
	expandedLabelIds: Set<string>,
) {
	if (!isBrowser()) return;
	try {
		const data: ExpandedLabelsCache = {
			version: VERSION,
			userKey: getCacheUserKey(),
			spaceId,
			expandedLabelIds: [...expandedLabelIds],
			updatedAt: Date.now(),
		};
		localStorage.setItem(storageKey(spaceId), JSON.stringify(data));
	} catch {
		// localStorage may be unavailable or full; runtime state remains authoritative.
	}
}
