import type { GlobalSearchResult, SpaceRecord } from "@neta-art/cohub";
import { idbGetAllByIndex, type SpaceRecordCacheRecord } from "$lib/cache/db";
import { getCacheUserKey } from "$lib/cache/keys";
import { sdk } from "$lib/sdk";
import {
	getSpacePublicProfile,
	normalizeSpacePublicProfile,
} from "$lib/space-profile";
import { getCachedSpaceList } from "$lib/stores/space-list-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import {
	buildSpaceMentionHref,
	buildSpaceMentionUri,
	type SpaceMentionSuggestion,
} from "./space";
import { selectSpaceMentionSuggestions } from "./space-mention-select";

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
	};
}

function remoteSpaceToSuggestion(
	item: GlobalSearchResult,
): SpaceMentionSuggestion | null {
	if (item.type !== "space") return null;
	const ownerProfile = "ownerProfile" in item ? item.ownerProfile : null;
	const spaceProfile = "spaceProfile" in item ? item.spaceProfile : null;
	return {
		type: "space",
		id: item.spaceId,
		spaceId: item.spaceId,
		name: item.title || item.spaceName || `space:${item.spaceId.slice(0, 8)}`,
		description: compactText(item.excerpt ?? null, 180),
		ownerProfile: ownerProfile ?? null,
		spaceProfile: normalizeSpacePublicProfile(spaceProfile),
		href: item.href || buildSpaceMentionHref(item.spaceId),
		uri: buildSpaceMentionUri(item.spaceId),
		activityAt: item.updatedAt,
		source: "remote",
	};
}

function shouldAbort(signal?: AbortSignal) {
	if (signal?.aborted) throw new DOMException("Search aborted", "AbortError");
}

export async function searchLocalSpaceMentions(
	query: string,
	options?: {
		signal?: AbortSignal;
		currentSpaceId?: string | null;
		limit?: number;
	},
): Promise<SpaceMentionSuggestion[]> {
	const normalized = query.trim();
	const spaces: SpaceRecord[] = [];
	const seen = new Set<string>();
	const add = (space: SpaceRecord) => {
		if (space.id === options?.currentSpaceId || seen.has(space.id)) return;
		seen.add(space.id);
		spaces.push(space);
	};

	for (const space of getCachedSpaceList() ?? []) add(space);
	shouldAbort(options?.signal);

	const userKey = getCacheUserKey();
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

	return selectSpaceMentionSuggestions(spaces.map(localSpaceToSuggestion), {
		query: normalized,
		currentSpaceId: options?.currentSpaceId,
		viewerUserUuid: userKey,
		limit: options?.limit ?? LOCAL_LIMIT,
	});
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
	const fetcher: typeof fetch = (input, init) =>
		fetch(input, { ...init, signal: options?.signal });
	const result = await sdk.search.query(
		{ q, limit: options?.limit ?? REMOTE_LIMIT, types: ["space"] },
		fetcher,
	);
	return selectSpaceMentionSuggestions(
		result.items
			.map(remoteSpaceToSuggestion)
			.filter((item): item is SpaceMentionSuggestion => Boolean(item)),
		{
			query: q,
			currentSpaceId: options?.currentSpaceId,
			viewerUserUuid: getCacheUserKey(),
			limit: options?.limit ?? REMOTE_LIMIT,
		},
	);
}
