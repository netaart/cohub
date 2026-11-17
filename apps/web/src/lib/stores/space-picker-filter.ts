import { getCacheUserKey } from "#lib/cache/keys.ts";

const VERSION = 2;
const PREFIX = "cohub:space-picker-filter";

export type SpaceFilterPref = "recent" | "all" | "mine" | "pinned";

const VALID_PREFS: ReadonlySet<string> = new Set([
	"recent",
	"all",
	"mine",
	"pinned",
]);

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function storageKey() {
	return `${PREFIX}:${encodeURIComponent(getCacheUserKey())}:v${VERSION}`;
}

export function getCachedSpaceFilterPref(): SpaceFilterPref {
	if (!isBrowser()) return "recent";
	try {
		const raw = localStorage.getItem(storageKey());
		// v2 defaults to "recent"; unknown or missing values (including v1
		// leftovers) fall back to it rather than the old "all" default.
		if (raw && VALID_PREFS.has(raw)) return raw as SpaceFilterPref;
		return "recent";
	} catch {
		return "recent";
	}
}

export function setCachedSpaceFilterPref(pref: SpaceFilterPref) {
	if (!isBrowser()) return;
	try {
		localStorage.setItem(storageKey(), pref);
	} catch {
		// localStorage may be unavailable or full; runtime state remains authoritative.
	}
}
