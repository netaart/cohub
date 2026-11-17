import type { SpaceRecord } from "@neta-art/cohub";
import { useCompactShell } from "#lib/layout/compact-shell.svelte.ts";
import { appAreaHref } from "#lib/mobile-nav.ts";
import { sdk } from "#lib/sdk.ts";
import { buildSpaceLandingRoute } from "#lib/space-routes.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";
import { getRecentSpace } from "#lib/stores/recent-space.ts";
import {
	getCachedSpaceList,
	patchCachedSpaceList,
	setCachedSpaceList,
} from "#lib/stores/space-list-cache.ts";
import { cacheSpaceRecordSoon } from "#lib/stores/space-record-cache.ts";

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

const PUBLIC_HOME = "/";

function localSpaceEntryRoute(): string | null {
	const userKey = authStore.userUuid;
	const recent = userKey ? getRecentSpace(userKey) : null;
	if (recent?.spaceId) return buildSpaceLandingRoute(recent.spaceId);
	const cached = getCachedSpaceList();
	return cached?.[0]?.id ? buildSpaceLandingRoute(cached[0].id) : null;
}

/** Local recent/cache first, then GET /api/spaces/default (ensures Home). */
export async function resolveSpaceEntryRoute(): Promise<string | null> {
	const local = localSpaceEntryRoute();
	if (local) return local;

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

/** Compact shells open Chats, except first-run accounts that land in Home. */
export async function resolveAppHomeRoute(): Promise<string> {
	const chats = appAreaHref("chats");
	if (useCompactShell() && localSpaceEntryRoute()) return chats;
	return (await resolveSpaceEntryRoute()) ?? chats;
}

export function appHomeHref(): string {
	if (!authStore.isAuthenticated) return PUBLIC_HOME;
	if (useCompactShell()) return appAreaHref("chats");
	return localSpaceEntryRoute() ?? PUBLIC_HOME;
}
