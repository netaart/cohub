import { selectSpacePickerItems } from "$lib/space-picker-model";
import { normalizeSpacePublicProfile } from "$lib/space-profile";
import type { SpaceMentionSuggestion } from "./space";

/**
 * Rank @-mention spaces with the same recent-visit model as the Space picker:
 * empty query stays on recently visited spaces (falling back to all), and a
 * typed query substring-matches names with recents first.
 */
export function selectSpaceMentionSuggestions(
	items: readonly SpaceMentionSuggestion[],
	options: {
		query?: string;
		currentSpaceId?: string | null;
		viewerUserUuid?: string | null;
		limit?: number;
	},
): SpaceMentionSuggestion[] {
	const query = options.query?.trim() ?? "";
	const candidates = items.filter(
		(item) => item.spaceId !== options.currentSpaceId,
	);
	return selectSpacePickerItems(candidates, {
		filter: query ? "all" : "recent",
		query,
		viewerUserUuid: options.viewerUserUuid,
		limit: options.limit,
	});
}

export function mergeSpaceMentionSuggestions(input: {
	local: SpaceMentionSuggestion[];
	remote: SpaceMentionSuggestion[];
	query?: string;
	currentSpaceId?: string | null;
	viewerUserUuid?: string | null;
	limit?: number;
}): SpaceMentionSuggestion[] {
	const byId = new Map<string, SpaceMentionSuggestion>();
	for (const item of input.local) {
		if (item.spaceId === input.currentSpaceId) continue;
		byId.set(item.spaceId, item);
	}
	for (const item of input.remote) {
		if (item.spaceId === input.currentSpaceId) continue;
		const existing = byId.get(item.spaceId);
		if (!existing) {
			byId.set(item.spaceId, item);
			continue;
		}
		byId.set(item.spaceId, {
			...existing,
			...item,
			ownerProfile: item.ownerProfile ?? existing.ownerProfile,
			spaceProfile: normalizeSpacePublicProfile(
				item.spaceProfile ?? existing.spaceProfile,
			),
			description: item.description ?? existing.description,
			source: "local+remote",
		});
	}
	return selectSpaceMentionSuggestions([...byId.values()], {
		query: input.query,
		currentSpaceId: input.currentSpaceId,
		viewerUserUuid: input.viewerUserUuid,
		limit: input.limit,
	});
}
