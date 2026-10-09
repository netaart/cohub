import type { GlobalSearchResult, GlobalSearchType } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import { patchCachedSpaceRecordSoon } from "$lib/stores/space-record-cache";

function cacheRemoteSpaceResult(item: GlobalSearchResult) {
	if (item.type !== "space") return;
	const result = item as GlobalSearchResult & {
		spaceName?: string | null;
		excerpt?: string | null;
	};
	patchCachedSpaceRecordSoon({
		id: item.spaceId,
		...(item.ownerProfile?.userUuid
			? { userUuid: item.ownerProfile.userUuid }
			: {}),
		name: result.spaceName ?? item.title ?? null,
		description: result.excerpt ?? null,
		title: item.title ?? null,
		publicProfile: item.spaceProfile ?? undefined,
		ownerProfile: item.ownerProfile ?? null,
		updatedAt: item.updatedAt ?? new Date(0).toISOString(),
	});
}

export async function searchRemoteCommandItems(
	query: string,
	options?: {
		signal?: AbortSignal;
		limit?: number;
		types?: GlobalSearchType[];
		spaceId?: string;
		labelRef?: string;
	},
) {
	const q = query.trim();
	if (q.length < 2 && !options?.labelRef) return [];
	const fetcher: typeof fetch = (input, init) =>
		fetch(input, { ...init, signal: options?.signal });
	const result = await sdk.search.query(
		{
			q,
			limit: options?.limit ?? 30,
			types: options?.types,
			spaceId: options?.spaceId,
			labelRef: options?.labelRef,
		},
		fetcher,
	);
	for (const item of result.items) cacheRemoteSpaceResult(item);
	return result.items;
}
