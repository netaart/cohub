const STORAGE_PREFIX = "cohub:account:v1";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Snapshot<T> = { data: T; updatedAt: number };

function storageKey(userKey: string, name: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userKey)}:${name}`;
}

export function readAccountSnapshot<T>(
	userKey: string,
	name: string,
): T | null {
	if (typeof localStorage === "undefined") return null;
	const key = storageKey(userKey, name);
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		const snapshot = JSON.parse(raw) as Partial<Snapshot<T>> | null;
		if (
			snapshot?.data != null &&
			typeof snapshot.updatedAt === "number" &&
			Date.now() - snapshot.updatedAt < MAX_AGE_MS
		)
			return snapshot.data;
		localStorage.removeItem(key);
	} catch {}
	return null;
}

export function writeAccountSnapshot<T>(
	userKey: string,
	name: string,
	data: T,
) {
	if (typeof localStorage === "undefined") return;
	try {
		const snapshot: Snapshot<T> = { data, updatedAt: Date.now() };
		localStorage.setItem(storageKey(userKey, name), JSON.stringify(snapshot));
	} catch {}
}

export function clearAccountSnapshots() {
	if (typeof localStorage === "undefined") return;
	try {
		for (let index = localStorage.length - 1; index >= 0; index -= 1) {
			const key = localStorage.key(index);
			if (key?.startsWith(`${STORAGE_PREFIX}:`)) localStorage.removeItem(key);
		}
	} catch {}
}
