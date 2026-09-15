import type { GlobalSearchResult } from "@neta-art/cohub";
import {
	getCommandPaletteDefaultItems,
	getLocalPaletteOverview,
} from "$lib/command-palette/default-items";
import { searchLocalCommandItems } from "$lib/command-palette/local-search";
import { getPaletteOverviewSnapshot } from "$lib/command-palette/palette-overview";
import { mergeLocalOverviewIntoSnapshot } from "$lib/command-palette/palette-overview-local";
import { searchRemoteCommandItems } from "$lib/command-palette/remote-search";
import type { CommandPaletteItem } from "$lib/command-palette/types";
import { sdk } from "$lib/sdk";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import type { SpaceMentionSuggestion } from "./space";
import { commandSpaceToMentionSuggestion } from "./space-mention-select";

export { mergeSpaceMentionSuggestions } from "./space-mention-select";

const SPACE_LINK_RESOLVE_LIMIT = 20;
const REMOTE_LIMIT = 30;

function isMentionSuggestion(
	item: SpaceMentionSuggestion | null,
): item is SpaceMentionSuggestion {
	return item !== null;
}

function toMentionSuggestions(
	items: CommandPaletteItem[],
	currentSpaceId?: string | null,
) {
	return items
		.map(commandSpaceToMentionSuggestion)
		.filter(isMentionSuggestion)
		.filter((item) => item.spaceId !== currentSpaceId);
}

function remoteSearchToSuggestion(
	item: GlobalSearchResult,
): SpaceMentionSuggestion | null {
	if (item.type !== "space") return null;
	return commandSpaceToMentionSuggestion({
		...item,
		excerpt: item.excerpt ?? null,
		spaceName: item.spaceName ?? null,
		sessionTitle: item.sessionTitle ?? null,
		viewerRelation: item.viewerRelation ?? null,
		viewerTier: item.effectiveTier ?? undefined,
		source: "remote",
	});
}

async function searchRecentSpaceDefaults(options?: {
	signal?: AbortSignal;
	currentSpaceId?: string | null;
	viewerUserUuid?: string | null;
}) {
	const localOverview = await getLocalPaletteOverview({
		signal: options?.signal,
		viewerUserUuid: options?.viewerUserUuid,
	});
	const snapshot = getPaletteOverviewSnapshot().data;
	const hasSnapshotItems = Boolean(
		snapshot?.spaces.length || snapshot?.recentSessions.length,
	);
	const overview =
		snapshot && hasSnapshotItems
			? mergeLocalOverviewIntoSnapshot(snapshot, localOverview)
			: localOverview;
	return getCommandPaletteDefaultItems({
		query: "",
		resourceTypes: ["space"],
		currentSpaceId: options?.currentSpaceId,
		signal: options?.signal,
		viewerUserUuid: options?.viewerUserUuid,
		paletteOverview: overview,
	});
}

export async function searchLocalSpaceMentions(
	query: string,
	options?: {
		signal?: AbortSignal;
		currentSpaceId?: string | null;
		viewerUserUuid?: string | null;
	},
): Promise<SpaceMentionSuggestion[]> {
	const normalized = query.trim();
	const items =
		normalized.length < 2
			? await searchRecentSpaceDefaults(options)
			: await searchLocalCommandItems(normalized, {
					signal: options?.signal,
					resourceTypes: ["space"],
					viewerUserUuid: options?.viewerUserUuid,
				});
	return toMentionSuggestions(items, options?.currentSpaceId);
}

export async function resolveSpaceMentionLabels(
	spaceIds: string[],
	options?: { signal?: AbortSignal; limit?: number },
): Promise<Map<string, string>> {
	const unique = [...new Set(spaceIds.filter(Boolean))].slice(
		0,
		options?.limit ?? SPACE_LINK_RESOLVE_LIMIT,
	);
	const resolved = new Map<string, string>();
	await Promise.all(
		unique.map(async (spaceId) => {
			try {
				const space = await sdk
					.space(spaceId)
					.get((input, init) =>
						fetch(input, { ...init, signal: options?.signal }),
					);
				cacheSpaceRecordSoon(space);
				const name = space.name ?? space.title;
				if (name) resolved.set(spaceId, name);
			} catch (error) {
				if ((error as { name?: string })?.name === "AbortError") return;
				// Detail endpoint intentionally returns minimal public/session-accessible
				// data when possible. If a space is unavailable, keep the fallback label.
			}
		}),
	);
	return resolved;
}

export async function searchRemoteSpaceMentions(
	query: string,
	options?: {
		signal?: AbortSignal;
		currentSpaceId?: string | null;
		limit?: number;
	},
): Promise<SpaceMentionSuggestion[]> {
	const q = query.trim();
	if (q.length < 2) return [];
	const result = await searchRemoteCommandItems(q, {
		signal: options?.signal,
		limit: options?.limit ?? REMOTE_LIMIT,
		types: ["space"],
	});
	return result
		.map(remoteSearchToSuggestion)
		.filter(isMentionSuggestion)
		.filter((item) => item.spaceId !== options?.currentSpaceId);
}
