/**
 * Framework-agnostic Space picker model: pure filtering, search, and ordering
 * shared by every host's consent dialog and Space chooser. Hosts supply their
 * own recency signal; this module never touches storage.
 */

export type SpacePickerFilter = "recent" | "all" | "mine" | "pinned";

export type SpacePickerItem = {
	id: string;
	name: string | null;
	ownerUserUuid?: string | null;
	isPinned?: boolean;
	isArchived?: boolean;
};

export type SpacePickerOptions = {
	filter: SpacePickerFilter;
	query?: string;
	viewerUserUuid?: string | null;
	/** Space ids ordered by most-recently visited first. */
	recentSpaceIds?: readonly string[];
	limit?: number;
};

export function normalizeSpacePickerQuery(value: string): string {
	return value.trim().toLocaleLowerCase();
}

export function orderSpacePickerItems<T extends SpacePickerItem>(
	items: readonly T[],
	recentSpaceIds: readonly string[] = [],
): T[] {
	const recentIndex = new Map(recentSpaceIds.map((id, index) => [id, index]));
	return [...items].sort((a, b) => {
		const recentA = recentIndex.get(a.id);
		const recentB = recentIndex.get(b.id);
		if (recentA !== undefined || recentB !== undefined) {
			if (recentA === undefined) return 1;
			if (recentB === undefined) return -1;
			return recentA - recentB;
		}
		return (a.name ?? a.id).localeCompare(b.name ?? b.id);
	});
}

export function filterSpacePickerItems<T extends SpacePickerItem>(
	items: readonly T[],
	options: SpacePickerOptions,
): T[] {
	const recentIds = new Set(options.recentSpaceIds ?? []);
	// Recent is the preferred first view, but a new user must still be able to
	// choose a Space before any local visit has been recorded.
	const effectiveFilter =
		options.filter === "recent" && recentIds.size === 0 ? "all" : options.filter;
	const normalizedQuery = normalizeSpacePickerQuery(options.query ?? "");
	return items.filter((item) => {
		if (effectiveFilter === "mine" && item.ownerUserUuid !== options.viewerUserUuid)
			return false;
		if (effectiveFilter === "pinned" && !item.isPinned) return false;
		if (item.isArchived) return false;
		if (effectiveFilter === "recent" && !recentIds.has(item.id)) return false;
		if (!normalizedQuery) return true;
		return normalizeSpacePickerQuery(item.name ?? item.id).includes(normalizedQuery);
	});
}

export function selectSpacePickerItems<T extends SpacePickerItem>(
	items: readonly T[],
	options: SpacePickerOptions,
): T[] {
	const filtered = filterSpacePickerItems(items, options);
	const ordered = orderSpacePickerItems(filtered, options.recentSpaceIds ?? []);
	return options.limit === undefined ? ordered : ordered.slice(0, options.limit);
}
