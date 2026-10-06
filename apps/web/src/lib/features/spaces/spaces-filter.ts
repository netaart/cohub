import type { SpaceRecord } from "@neta-art/cohub";
import type { Compare } from "$lib/lists/live-list-core";

export const SPACES_FILTERS = [
	"recent",
	"all",
	"mine",
	"pinned",
	"archived",
] as const;

export type SpacesFilter = (typeof SPACES_FILTERS)[number];

export function matchesSpacesFilter(space: SpaceRecord, filter: SpacesFilter) {
	if (space.isArchived) return filter === "archived";
	switch (filter) {
		case "recent":
		case "all":
			return true;
		case "mine":
			return space.relation === "owner";
		case "pinned":
			return Boolean(space.isPinned);
		case "archived":
			return false;
	}
}

export function time(value: string | null | undefined) {
	return Date.parse(value ?? "") || 0;
}

export const compareSpaces: Compare<SpaceRecord> = (a, b) => {
	const personal = time(b.personalActivityAt) - time(a.personalActivityAt);
	if (personal) return personal;
	const relation =
		(a.relation === "owner" ? 0 : 1) - (b.relation === "owner" ? 0 : 1);
	if (relation) return relation;
	const space =
		time(b.lastActivityAt ?? b.updatedAt ?? b.createdAt) -
		time(a.lastActivityAt ?? a.updatedAt ?? a.createdAt);
	if (space) return space;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
