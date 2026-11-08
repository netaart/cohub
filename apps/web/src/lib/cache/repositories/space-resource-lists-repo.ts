import {
	idbGet,
	idbPut,
	type SpaceResourceListCacheRecord,
} from "$lib/cache/db";
import {
	canUseUserScopedCache,
	getCacheUserKeyAsync,
	spaceResourceListKey,
} from "$lib/cache/keys";

async function resolveUserKey() {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey) ? userKey : null;
}

export async function readSpaceResourceList<T>(
	spaceId: string,
	kind: string,
): Promise<T[] | null> {
	const userKey = await resolveUserKey();
	if (!userKey) return null;
	const record = await idbGet<SpaceResourceListCacheRecord>(
		"space_resource_lists",
		spaceResourceListKey(userKey, spaceId, kind),
	).catch(() => null);
	return Array.isArray(record?.items) ? (record.items as T[]) : null;
}

export async function writeSpaceResourceList<T>(
	spaceId: string,
	kind: string,
	items: T[],
) {
	const userKey = await resolveUserKey();
	if (!userKey) return;
	const now = Date.now();
	await idbPut<SpaceResourceListCacheRecord>("space_resource_lists", {
		key: spaceResourceListKey(userKey, spaceId, kind),
		userKey,
		spaceId,
		kind,
		items,
		updatedAt: now,
		lastAccessedAt: now,
	}).catch(() => undefined);
}
