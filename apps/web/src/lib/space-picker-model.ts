import {
	filterSpacePickerItems as filterSpacePickerItemsCore,
	normalizeSpacePickerQuery,
	orderSpacePickerItems as orderSpacePickerItemsCore,
	type SpacePickerFilter,
	type SpacePickerItem,
} from "@neta-art/cohub/space-picker";
import { getRecentSpaces } from "$lib/stores/recent-space";

export type { SpacePickerFilter, SpacePickerItem };
export { normalizeSpacePickerQuery };

const recentSpaceIds = (viewerUserUuid?: string | null): string[] =>
	(viewerUserUuid ? getRecentSpaces(viewerUserUuid) : []).map(
		(entry) => entry.spaceId,
	);

export function orderSpacePickerItems<T extends SpacePickerItem>(
	items: readonly T[],
	viewerUserUuid?: string | null,
): T[] {
	return orderSpacePickerItemsCore(items, recentSpaceIds(viewerUserUuid));
}

export function filterSpacePickerItems<T extends SpacePickerItem>(
	items: readonly T[],
	filter: SpacePickerFilter,
	query: string,
	viewerUserUuid?: string | null,
): T[] {
	return filterSpacePickerItemsCore(items, {
		filter,
		query,
		viewerUserUuid,
		recentSpaceIds: recentSpaceIds(viewerUserUuid),
	});
}
