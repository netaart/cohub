import type { SpaceRecord } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { getRecentSpace } from "$lib/stores/recent-space";
import {
	getCachedSpaceList,
	patchCachedSpaceList,
	setCachedSpaceList,
} from "$lib/stores/space-list-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";

function rememberSpace(space: SpaceRecord) {
	cacheSpaceRecordSoon(space);
	const cached = getCachedSpaceList();
	const isNew = !cached?.some((item) => item.id === space.id);
	if (!cached) {
		setCachedSpaceList([space]);
	} else if (!isNew) {
		patchCachedSpaceList((items) =>
			items.map((item) =>
				item.id === space.id ? { ...item, ...space } : item,
			),
		);
	} else {
		patchCachedSpaceList((items) => [space, ...items]);
	}
	if (isNew && typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent("cohub:space-created"));
	}
}

/**
 * Resolve where an authenticated user should land.
 * Prefers local recent/cache, then GET /api/spaces/default.
 */
export async function resolveAppEntryRoute(): Promise<string | null> {
	const userKey = authStore.userUuid;
	if (userKey) {
		const recent = getRecentSpace(userKey);
		if (recent?.spaceId) return buildSpaceLandingRoute(recent.spaceId);
	}

	const cached = getCachedSpaceList();
	if (cached?.[0]?.id) return buildSpaceLandingRoute(cached[0].id);

	try {
		const defaultResult = await sdk.spaces.getDefault();
		const space = defaultResult?.space ?? null;
		if (space?.id) {
			rememberSpace(space);
			return buildSpaceLandingRoute(space.id);
		}
	} catch (error) {
		console.warn("[app-entry] Failed to resolve default space:", error);
	}

	return null;
}
