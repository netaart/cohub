import type { SpaceRecord } from "@neta-art/cohub";

export const SPACES_FILTERS = [
	"recent",
	"all",
	"mine",
	"pinned",
	"archived",
] as const;

export type SpacesFilter = (typeof SPACES_FILTERS)[number];

export function matchesSpacesFilter(space: SpaceRecord, filter: SpacesFilter) {
	return filter === "archived" ? Boolean(space.isArchived) : !space.isArchived;
}
