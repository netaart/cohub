import type { SessionFileRecord } from "@cohub/protocol/model";
import {
	idbDelete,
	idbGet,
	idbGetAllByIndex,
	idbPut,
	type SessionFilesCacheRecord,
} from "$lib/cache/db";
import {
	canUseUserScopedCache,
	getCacheUserKeyAsync,
	sessionFilesKey,
} from "$lib/cache/keys";

const SESSIONS_PER_SPACE = 100;
const ACCESS_TOUCH_INTERVAL_MS = 60_000;

async function resolveUserKey() {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey) ? userKey : null;
}

async function prune(userKey: string, spaceId: string) {
	const records = await idbGetAllByIndex<SessionFilesCacheRecord>(
		"session_files",
		"by_user_space",
		IDBKeyRange.only([userKey, spaceId]),
	);
	if (records.length <= SESSIONS_PER_SPACE) return;
	const evicted = [...records]
		.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
		.slice(SESSIONS_PER_SPACE);
	await Promise.all(
		evicted.map((record) => idbDelete("session_files", record.key)),
	);
}

export async function readSessionFiles(spaceId: string, sessionId: string) {
	const userKey = await resolveUserKey();
	if (!userKey) return null;
	const record = await idbGet<SessionFilesCacheRecord>(
		"session_files",
		sessionFilesKey(userKey, spaceId, sessionId),
	);
	if (!record) return null;
	const now = Date.now();
	if (now - record.lastAccessedAt > ACCESS_TOUCH_INTERVAL_MS) {
		void idbPut("session_files", { ...record, lastAccessedAt: now }).catch(
			() => undefined,
		);
	}
	return record.files;
}

export async function writeSessionFiles(
	spaceId: string,
	sessionId: string,
	files: SessionFileRecord[],
) {
	const userKey = await resolveUserKey();
	if (!userKey) return;
	const now = Date.now();
	await idbPut<SessionFilesCacheRecord>("session_files", {
		key: sessionFilesKey(userKey, spaceId, sessionId),
		userKey,
		spaceId,
		sessionId,
		files,
		updatedAt: now,
		lastAccessedAt: now,
	});
	void prune(userKey, spaceId).catch(() => undefined);
}
