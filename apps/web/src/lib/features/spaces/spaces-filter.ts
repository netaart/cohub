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

const byIdDesc = (a: SpaceRecord, b: SpaceRecord) =>
	a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

function byTime(
	at: (space: SpaceRecord) => string | null | undefined,
): Compare<SpaceRecord> {
	return (a, b) => time(at(b)) - time(at(a)) || byIdDesc(a, b);
}

const byPersonalActivity = byTime((space) => space.personalActivityAt);
const byJoined = byTime((space) => space.joinedAt);

export function compareSpaces(filter: SpacesFilter): Compare<SpaceRecord> {
	return filter === "recent" ? byPersonalActivity : byJoined;
}
