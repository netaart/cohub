import type { GlobalSearchResult } from "@neta-art/cohub";
import { mergeCommandResults } from "$lib/command-palette/merge-results";
import type { CommandPaletteItem } from "$lib/command-palette/types";
import { normalizeSpacePublicProfile } from "$lib/space-profile";
import {
	buildSpaceMentionHref,
	buildSpaceMentionUri,
	type SpaceMentionSuggestion,
} from "./space";

function mentionSource(
	source: CommandPaletteItem["source"],
): SpaceMentionSuggestion["source"] {
	if (source === "remote" || source === "local+remote") return source;
	return "local";
}

export function commandSpaceToMentionSuggestion(
	item: CommandPaletteItem,
): SpaceMentionSuggestion | null {
	if (item.type !== "space") return null;
	return {
		type: "space",
		id: item.spaceId,
		spaceId: item.spaceId,
		name: item.spaceName || item.title,
		description: item.excerpt,
		ownerProfile: item.ownerProfile ?? null,
		spaceProfile: normalizeSpacePublicProfile(item.spaceProfile),
		href: item.href || buildSpaceMentionHref(item.spaceId),
		uri: buildSpaceMentionUri(item.spaceId),
		activityAt: item.updatedAt,
		source: mentionSource(item.source),
		score: item.score,
		textScore: item.textScore,
		recencyScore: item.recencyScore,
		typePriorityScore: item.typePriorityScore,
		viewerRelation: item.viewerRelation,
		viewerTier: item.viewerTier,
	};
}

function mentionToPaletteItem(
	item: SpaceMentionSuggestion,
): CommandPaletteItem {
	return {
		type: "space",
		id: item.spaceId,
		spaceId: item.spaceId,
		sessionId: null,
		turnId: null,
		sequence: null,
		title: item.name,
		excerpt: item.description,
		spaceName: item.name,
		ownerProfile: item.ownerProfile,
		spaceProfile: item.spaceProfile,
		sessionTitle: null,
		matchedField: "name",
		href: item.href,
		score: item.score,
		textScore: item.textScore,
		recencyScore: item.recencyScore,
		typePriorityScore: item.typePriorityScore,
		viewerRelation: item.viewerRelation,
		viewerTier: item.viewerTier,
		updatedAt: item.activityAt,
		source: item.source,
	};
}

function mentionToSearchResult(
	item: SpaceMentionSuggestion,
): GlobalSearchResult {
	return {
		type: "space",
		id: item.spaceId,
		spaceId: item.spaceId,
		sessionId: null,
		turnId: null,
		sequence: null,
		title: item.name,
		excerpt: item.description,
		spaceName: item.name,
		ownerProfile: item.ownerProfile as GlobalSearchResult["ownerProfile"],
		spaceProfile: item.spaceProfile,
		sessionTitle: null,
		matchedField: "name",
		viewerRelation:
			item.viewerRelation === "unknown" ? null : (item.viewerRelation ?? null),
		effectiveTier: item.viewerTier ?? null,
		href: item.href,
		score: item.score,
		textScore: item.textScore,
		recencyScore: item.recencyScore,
		typePriorityScore: item.typePriorityScore,
		updatedAt: item.activityAt,
		source: "remote",
	};
}

function excludeCurrent(
	items: readonly SpaceMentionSuggestion[],
	currentSpaceId?: string | null,
) {
	return items.filter((item) => item.spaceId !== currentSpaceId);
}

/**
 * Same merge as the command-palette Recent space list:
 * empty query keeps the Recent default order; typed queries go through
 * `mergeCommandResults` (fuzzy text + viewer tier + recency).
 */
export function mergeSpaceMentionSuggestions(input: {
	local: SpaceMentionSuggestion[];
	remote: SpaceMentionSuggestion[];
	query?: string;
	currentSpaceId?: string | null;
	limit?: number;
}): SpaceMentionSuggestion[] {
	const query = input.query?.trim() ?? "";
	const local = excludeCurrent(input.local, input.currentSpaceId);
	const remote = excludeCurrent(input.remote, input.currentSpaceId);
	if (!query) return local.slice(0, input.limit ?? 50);
	return mergeCommandResults({
		local: local.map(mentionToPaletteItem),
		remote: remote.map(mentionToSearchResult),
		limit: input.limit ?? 50,
		longQuery: query.length >= 12,
	})
		.map(commandSpaceToMentionSuggestion)
		.filter((item): item is SpaceMentionSuggestion => Boolean(item));
}
