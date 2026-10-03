import type { SpaceListPage, SpaceRecord } from "@neta-art/cohub";
import { idbGet, idbPut } from "$lib/cache/db";
import { getCacheUserKey } from "$lib/cache/keys";
import { cacheSpaceRecordsSoon } from "$lib/stores/space-record-cache";

type CachedSpacePage = {
	key: string;
	userKey: string;
	filter: string;
	query: string;
	items: SpaceRecord[];
	updatedAt: number;
};

function cacheKey(filter: string, query: string) {
	return `${encodeURIComponent(getCacheUserKey())}:${filter}:${encodeURIComponent(query.trim().toLocaleLowerCase())}`;
}

export async function getCachedSpacePage(filter: string, query: string) {
	const userKey = getCacheUserKey();
	const record = await idbGet<CachedSpacePage>(
		"space_lists",
		cacheKey(filter, query),
	);
	return record?.userKey === userKey ? record : null;
}

export async function setCachedSpacePage(
	filter: string,
	query: string,
	page: SpaceListPage,
) {
	const key = cacheKey(filter, query);
	const userKey = getCacheUserKey();
	const record: CachedSpacePage = {
		key,
		userKey,
		filter,
		query: query.trim().toLocaleLowerCase(),
		items: page.items,
		updatedAt: Date.now(),
	};
	await idbPut("space_lists", record);
	cacheSpaceRecordsSoon(page.items);
	return record;
}
