// Tracks recently visited spaces so the app can prioritize them locally.
// Stored in localStorage under "cohub:recent-spaces:<userUuid>:v1".
// Reads the legacy single-entry key "cohub:recent-space:<userUuid>" for migration.

const LEGACY_STORAGE_PREFIX = "cohub:recent-space:";
const STORAGE_PREFIX = "cohub:recent-spaces:";
const STORAGE_VERSION = "v1";
const MAX_RECENT_SPACES = 10;
const EXPIRE_AFTER_MS = 90 * 86_400_000;

export type RecentSpaceEntry = {
	spaceId: string;
	sessionId: string | null;
	timestamp: number;
};

function storageKey(userUuid: string): string {
	return `${STORAGE_PREFIX}${userUuid}:${STORAGE_VERSION}`;
}

function legacyStorageKey(userUuid: string): string {
	return `${LEGACY_STORAGE_PREFIX}${userUuid}`;
}

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function normalizeEntry(value: unknown): RecentSpaceEntry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const parsed = value as Partial<RecentSpaceEntry>;
	if (typeof parsed.spaceId !== "string" || !parsed.spaceId) return null;
	if (typeof parsed.timestamp !== "number") return null;
	if (Date.now() - parsed.timestamp > EXPIRE_AFTER_MS) return null;
	return {
		spaceId: parsed.spaceId,
		sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
		timestamp: parsed.timestamp,
	};
}

function normalizeEntries(values: unknown): RecentSpaceEntry[] {
	if (!Array.isArray(values)) return [];
	const byId = new Map<string, RecentSpaceEntry>();
	for (const value of values) {
		const entry = normalizeEntry(value);
		if (!entry) continue;
		const previous = byId.get(entry.spaceId);
		if (!previous || entry.timestamp > previous.timestamp) {
			byId.set(entry.spaceId, entry);
		}
	}
	return Array.from(byId.values())
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, MAX_RECENT_SPACES);
}

function readLegacyEntry(userUuid: string): RecentSpaceEntry | null {
	if (!isBrowser()) return null;
	try {
		const raw = localStorage.getItem(legacyStorageKey(userUuid));
		if (!raw) return null;
		return normalizeEntry(JSON.parse(raw));
	} catch {
		return null;
	}
}

function writeEntries(userUuid: string, entries: RecentSpaceEntry[]) {
	if (!isBrowser()) return;
	try {
		localStorage.setItem(
			storageKey(userUuid),
			JSON.stringify(normalizeEntries(entries)),
		);
	} catch {
		// Storage full or disabled — ignore gracefully.
	}
}

function readEntries(userUuid: string): RecentSpaceEntry[] {
	if (!isBrowser()) return [];
	try {
		const raw = localStorage.getItem(storageKey(userUuid));
		const current = raw ? normalizeEntries(JSON.parse(raw)) : [];
		const legacy = readLegacyEntry(userUuid);
		if (!legacy) return current;

		const merged = normalizeEntries([legacy, ...current]);
		writeEntries(userUuid, merged);
		return merged;
	} catch {
		const legacy = readLegacyEntry(userUuid);
		return legacy ? [legacy] : [];
	}
}

type VisitListener = (entry: RecentSpaceEntry) => void;
const visitListeners = new Set<VisitListener>();

export function onRecentSpaceVisit(listener: VisitListener): () => void {
	visitListeners.add(listener);
	return () => visitListeners.delete(listener);
}

export function setRecentSpace(
	userUuid: string,
	spaceId: string,
	sessionId: string | null = null,
) {
	const trimmedSpaceId = spaceId.trim();
	if (!trimmedSpaceId) return;
	const nextEntry: RecentSpaceEntry = {
		spaceId: trimmedSpaceId,
		sessionId,
		timestamp: Date.now(),
	};
	writeEntries(userUuid, [
		nextEntry,
		...readEntries(userUuid).filter(
			(entry) => entry.spaceId !== trimmedSpaceId,
		),
	]);
	for (const listener of [...visitListeners]) listener(nextEntry);
}

export function getRecentSpaces(userUuid: string): RecentSpaceEntry[] {
	return readEntries(userUuid);
}

export function getRecentSpace(
	userUuid: string,
): { spaceId: string; sessionId: string | null } | null {
	const entry = readEntries(userUuid)[0];
	if (!entry) return null;
	return { spaceId: entry.spaceId, sessionId: entry.sessionId };
}

export function clearRecentSpace(userUuid: string) {
	if (!isBrowser()) return;
	try {
		localStorage.removeItem(storageKey(userUuid));
		localStorage.removeItem(legacyStorageKey(userUuid));
	} catch {
		// ignore
	}
}
