import type { GlobalSearchResult } from "@neta-art/cohub";
import { mergeCommandResults } from "$lib/command-palette/merge-results";
import type { CommandPaletteItem } from "$lib/command-palette/types";
import { selectSpacePickerItems } from "$lib/space-picker-model";
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

/**
 * Empty `@` uses the Space picker recent-visit list. Typed queries reuse
 * command-palette space ranking (fuzzy text + viewer tier + recency), so
 * `@tt` matches `a: tt`.
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
	if (!query) {
		return selectSpacePickerItems(candidates, {
			filter: "recent",
			query,
			viewerUserUuid: options.viewerUserUuid,
			limit: options.limit,
		});
	}
	return mergeCommandResults({
		local: candidates
			.filter((item) => item.source !== "remote")
			.map(mentionToPaletteItem),
		remote: candidates
			.filter((item) => item.source === "remote")
			.map(mentionToSearchResult),
		limit: options.limit,
		longQuery: query.length >= 12,
	})
		.map(commandSpaceToMentionSuggestion)
		.filter((item): item is SpaceMentionSuggestion => Boolean(item));
}

export function mergeSpaceMentionSuggestions(input: {
	local: SpaceMentionSuggestion[];
	remote: SpaceMentionSuggestion[];
	query?: string;
	currentSpaceId?: string | null;
	viewerUserUuid?: string | null;
	limit?: number;
}): SpaceMentionSuggestion[] {
	const query = input.query?.trim() ?? "";
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
			score: Math.max(existing.score, item.score),
			textScore: Math.max(existing.textScore, item.textScore),
			recencyScore: Math.max(existing.recencyScore, item.recencyScore),
			typePriorityScore: Math.max(
				existing.typePriorityScore,
				item.typePriorityScore,
			),
			viewerRelation: item.viewerRelation ?? existing.viewerRelation,
			viewerTier: item.viewerTier ?? existing.viewerTier,
		});
	}
	return selectSpaceMentionSuggestions([...byId.values()], {
		query,
		currentSpaceId: input.currentSpaceId,
		viewerUserUuid: input.viewerUserUuid,
		limit: input.limit,
	});
}
