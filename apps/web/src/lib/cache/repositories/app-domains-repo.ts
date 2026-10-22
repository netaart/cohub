import type { AppDomainListResponse } from "@neta-art/cohub";
import { type AppDomainsCacheRecord, idbGet, idbPut } from "$lib/cache/db";
import {
	appDomainsKey,
	canUseUserScopedCache,
	getCacheUserKeyAsync,
} from "$lib/cache/keys";

async function resolveUserKey() {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey) ? userKey : null;
}

export async function readAppDomains(spaceId: string, appId: string) {
	const userKey = await resolveUserKey();
	if (!userKey) return null;
	const record = await idbGet<AppDomainsCacheRecord>(
		"app_domains",
		appDomainsKey(userKey, spaceId, appId),
	).catch(() => null);
	return record?.list ?? null;
}

/** Stores only server responses (or server-sent events applied to them). */
export async function writeAppDomains(
	spaceId: string,
	appId: string,
	list: AppDomainListResponse,
) {
	const userKey = await resolveUserKey();
	if (!userKey) return;
	const now = Date.now();
	await idbPut<AppDomainsCacheRecord>("app_domains", {
		key: appDomainsKey(userKey, spaceId, appId),
		userKey,
		spaceId,
		appId,
		list,
		updatedAt: now,
		lastAccessedAt: now,
	}).catch(() => undefined);
}
