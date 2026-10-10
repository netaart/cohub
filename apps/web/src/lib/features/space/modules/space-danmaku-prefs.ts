// Live danmaku (floating messages) preference — a lightweight, best-effort
// localStorage-backed toggle. Mirrors the space-config pattern:
// module-level singleton, synchronous read, subscribe for reactive updates.

const STORAGE_KEY = "cohub:space-danmaku:v1";
const DEFAULT_ENABLED = true;

type StoredPrefs = { enabled: boolean; version: 1 };

let enabled = DEFAULT_ENABLED;
const listeners = new Set<(enabled: boolean) => void>();

function readEnabled(): boolean {
	if (typeof localStorage === "undefined") return DEFAULT_ENABLED;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_ENABLED;
		const parsed = JSON.parse(raw) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as { enabled?: unknown }).enabled === "boolean"
		) {
			return (parsed as { enabled: boolean }).enabled;
		}
	} catch {
		// Ignore malformed storage — never block the workspace.
	}
	return DEFAULT_ENABLED;
}

function writeEnabled(value: boolean) {
	if (typeof localStorage === "undefined") return;
	try {
		const prefs: StoredPrefs = { enabled: value, version: 1 };
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Best-effort; storage may be unavailable (private mode, quota, etc.).
	}
}

// Initialize from cache at module load (client-only).
enabled = readEnabled();

export function isDanmakuEnabled(): boolean {
	return enabled;
}

export function setDanmakuEnabled(value: boolean): void {
	if (enabled === value) return;
	enabled = value;
	writeEnabled(value);
	for (const listener of listeners) listener(value);
}

export function subscribeDanmakuPrefs(
	listener: (enabled: boolean) => void,
): () => void {
	listeners.add(listener);
	listener(enabled);
	return () => {
		listeners.delete(listener);
	};
}
