import type { LikeResourceType } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "$lib/cache/broadcast";
import { idbGet, idbPut, type ViewerLikeCacheRecord } from "$lib/cache/db";
import {
	canUseUserScopedCache,
	getCacheUserKey,
	viewerLikeKey,
} from "$lib/cache/keys";

function userKey() {
	const key = getCacheUserKey();
	return canUseUserScopedCache(key) ? key : null;
}

export async function readViewerLike(
	resourceType: LikeResourceType,
	resourceId: string,
): Promise<boolean | null> {
	const key = userKey();
	if (!key) return null;
	const record = await idbGet<ViewerLikeCacheRecord>(
		"viewer_likes",
		viewerLikeKey(key, resourceType, resourceId),
	).catch(() => null);
	return record?.liked ?? null;
}

export async function writeViewerLike(
	resourceType: LikeResourceType,
	resourceId: string,
	liked: boolean,
) {
	const key = userKey();
	if (!key) return;
	const now = Date.now();
	const recordKey = viewerLikeKey(key, resourceType, resourceId);
	await idbPut<ViewerLikeCacheRecord>("viewer_likes", {
		key: recordKey,
		userKey: key,
		resourceType,
		resourceId,
		liked,
		updatedAt: now,
		lastAccessedAt: now,
	}).catch(() => undefined);
	publishCacheMessage({
		type: "cache-updated",
		store: "viewer_likes",
		key: recordKey,
		userKey: key,
		resourceType,
		resourceRef: resourceId,
		updatedAt: now,
	});
}

export function onViewerLikeChanged(
	resourceType: LikeResourceType,
	resourceId: string,
	handler: () => void,
) {
	return subscribeCacheMessages((message) => {
		if (
			message.store === "viewer_likes" &&
			message.userKey === getCacheUserKey() &&
			message.resourceType === resourceType &&
			message.resourceRef === resourceId
		)
			handler();
	});
}
