// Persists the sessions inbox source filter per user.
// Stored in localStorage under "cohub:sessions-source-filter:<userUuid>:v1".

const STORAGE_PREFIX = "cohub:sessions-source-filter:";
const STORAGE_VERSION = "v1";

export type SessionsSourceFilter = "web" | "all";

function storageKey(userUuid: string): string {
	return `${STORAGE_PREFIX}${userUuid}:${STORAGE_VERSION}`;
}

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function getSessionsSourceFilter(
	userUuid: string,
): SessionsSourceFilter {
	if (!userUuid || !isBrowser()) return "web";
	try {
		const raw = localStorage.getItem(storageKey(userUuid));
		if (raw === "all") return "all";
	} catch {
		// Storage disabled — ignore.
	}
	return "web";
}

export function setSessionsSourceFilter(
	userUuid: string,
	filter: SessionsSourceFilter,
): void {
	if (!userUuid || !isBrowser()) return;
	try {
		localStorage.setItem(storageKey(userUuid), filter);
	} catch {
		// Storage full or disabled — ignore.
	}
}
