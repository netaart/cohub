import type { GlobalSearchResult, SpaceRecord } from "@neta-art/cohub";
import { idbGetAllByIndex, type SpaceRecordCacheRecord } from "$lib/cache/db";
import { getCacheUserKey } from "$lib/cache/keys";
import {
	searchLocalCommandItems,
	spaceToItem,
} from "$lib/command-palette/local-search";
import { searchRemoteCommandItems } from "$lib/command-palette/remote-search";
import { sortCommandItems } from "$lib/command-palette/score";
import { sdk } from "$lib/sdk";
import { getSpacePublicProfile } from "$lib/space-profile";
import { getCachedSpaceList } from "$lib/stores/space-list-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import {
	buildSpaceMentionHref,
	buildSpaceMentionUri,
	type SpaceMentionSuggestion,
} from "./space";
import {
	commandSpaceToMentionSuggestion,
	selectSpaceMentionSuggestions,
} from "./space-mention-select";

export { mergeSpaceMentionSuggestions } from "./space-mention-select";

const SPACE_LINK_RESOLVE_LIMIT = 20;

const LOCAL_LIMIT = 24;
const REMOTE_LIMIT = 30;

function compactText(value: string | null | undefined, limit: number) {
	const text = (value ?? "").replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.length > limit
		? `${text.slice(0, Math.max(0, limit - 1))}…`
		: text;
}

function spaceName(space: Pick<SpaceRecord, "name" | "title" | "id">) {
	return space.name ?? space.title ?? `space:${space.id.slice(0, 8)}`;
}

function localSpaceToSuggestion(space: SpaceRecord): SpaceMentionSuggestion {
	return {
		type: "space",
		id: space.id,
		spaceId: space.id,
		name: spaceName(space),
		description: compactText(space.description, 180),
		ownerProfile: space.ownerProfile ?? null,
		spaceProfile: getSpacePublicProfile(space),
		href: buildSpaceMentionHref(space.id),
		uri: buildSpaceMentionUri(space.id),
		activityAt:
			space.lastActivityAt ?? space.updatedAt ?? space.createdAt ?? null,
		source: "local",
		score: 0,
		textScore: 0,
		recencyScore: 0,
		typePriorityScore: 0,
	};
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

function shouldAbort(signal?: AbortSignal) {
	if (signal?.aborted) throw new DOMException("Search aborted", "AbortError");
}

function isMentionSuggestion(
	item: SpaceMentionSuggestion | null,
): item is SpaceMentionSuggestion {
	return item !== null;
}

function excludeCurrentSpace(
	item: SpaceMentionSuggestion,
	currentSpaceId?: string | null,
) {
	return item.spaceId !== currentSpaceId;
}

async function loadLocalSpaces(
	userKey: string,
	options?: { signal?: AbortSignal; currentSpaceId?: string | null },
) {
	const spaces: SpaceRecord[] = [];
	const seen = new Set<string>();
	const add = (space: SpaceRecord) => {
		if (space.id === options?.currentSpaceId || seen.has(space.id)) return;
		seen.add(space.id);
		spaces.push(space);
	};

	for (const space of getCachedSpaceList() ?? []) add(space);
	shouldAbort(options?.signal);

	const records = await idbGetAllByIndex<SpaceRecordCacheRecord>(
		"space_records",
		"by_updated_at",
		IDBKeyRange.lowerBound(0),
	);
	shouldAbort(options?.signal);
	for (const record of records) {
		if (record.userKey !== userKey) continue;
		add(record.space);
	}
	return spaces;
}

export async function searchLocalSpaceMentions(
	query: string,
	options?: {
		signal?: AbortSignal;
		currentSpaceId?: string | null;
		viewerUserUuid?: string | null;
		limit?: number;
	},
): Promise<SpaceMentionSuggestion[]> {
	const normalized = query.trim();
	const userKey = getCacheUserKey();
	const viewerUserUuid = options?.viewerUserUuid ?? userKey;
	const limit = options?.limit ?? LOCAL_LIMIT;

	if (normalized.length >= 2) {
		const items = await searchLocalCommandItems(normalized, {
			signal: options?.signal,
			resourceTypes: ["space"],
			viewerUserUuid,
		});
		return items
			.map(commandSpaceToMentionSuggestion)
			.filter(isMentionSuggestion)
			.filter((item) => excludeCurrentSpace(item, options?.currentSpaceId))
			.slice(0, limit);
	}

	const spaces = await loadLocalSpaces(userKey, options);
	if (!normalized) {
		return selectSpaceMentionSuggestions(spaces.map(localSpaceToSuggestion), {
			query: "",
			currentSpaceId: options?.currentSpaceId,
			viewerUserUuid,
			limit,
		});
	}

	return sortCommandItems(
		spaces
			.map((space) => spaceToItem(space, normalized, viewerUserUuid))
			.filter((item): item is NonNullable<typeof item> => Boolean(item)),
	)
		.map(commandSpaceToMentionSuggestion)
		.filter((item): item is SpaceMentionSuggestion => Boolean(item))
		.slice(0, limit);
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
		.filter((item) => excludeCurrentSpace(item, options?.currentSpaceId));
}
