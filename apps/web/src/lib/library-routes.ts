import {
	isUuid,
	type ResourceAppTarget,
	readResourceAppTarget,
	writeResourceAppTarget,
} from "@cohub/protocol";

export const LIBRARY_ENTITIES = ["spaces", "apps", "scheduled"] as const;
export type LibraryEntity = (typeof LIBRARY_ENTITIES)[number];
export type LibraryItemEntity = Exclude<LibraryEntity, "spaces">;

const RESERVED_SPACE_SEGMENTS = new Set(["new", "apps", "scheduled"]);

export function isSpaceIdSegment(segment: string | null | undefined) {
	return Boolean(segment) && !RESERVED_SPACE_SEGMENTS.has(segment as string);
}

const ITEM_RESOURCE = {
	apps: "app",
	scheduled: "cronjob",
} as const satisfies Record<LibraryItemEntity, ResourceAppTarget["kind"]>;

export function libraryHref(entity: LibraryEntity) {
	return entity === "spaces" ? "/spaces" : `/spaces/${entity}`;
}

export function libraryEntityAt(pathname: string): LibraryEntity | null {
	const match = /^\/spaces(?:\/(apps|scheduled))?\/?$/.exec(pathname);
	if (!match) return null;
	return (match[1] as LibraryItemEntity | undefined) ?? "spaces";
}

export type LibrarySelection = {
	spaceId: string;
	target: ResourceAppTarget;
};

export function libraryItemHref(
	entity: LibraryItemEntity,
	spaceId: string,
	itemId: string,
) {
	const params = new URLSearchParams({ space: spaceId });
	writeResourceAppTarget(params, { kind: ITEM_RESOURCE[entity], id: itemId });
	return `${libraryHref(entity)}?${params}`;
}

export function librarySelectionAt(url: URL): LibrarySelection | null {
	const entity = libraryEntityAt(url.pathname);
	if (!entity || entity === "spaces") return null;
	const spaceId = url.searchParams.get("space");
	const target = readResourceAppTarget(url.searchParams);
	if (!spaceId || !isUuid(spaceId) || target?.kind !== ITEM_RESOURCE[entity])
		return null;
	return { spaceId, target };
}

export function librarySpaceAt(url: URL) {
	const entity = libraryEntityAt(url.pathname);
	if (!entity || entity === "spaces") return null;
	const spaceId = url.searchParams.get("space");
	return spaceId && isUuid(spaceId) ? spaceId : null;
}
