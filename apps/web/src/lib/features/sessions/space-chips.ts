import type { SpaceRecord, UserSessionSpaceSummary } from "@neta-art/cohub";
import { sameData } from "#lib/lists/live-list-core.ts";

const SPACE_CHIP_LIMIT = 6;

export function nextSpaceChips(
	current: UserSessionSpaceSummary[],
	spaces: readonly SpaceRecord[],
	hold: boolean,
	summarize: (space: SpaceRecord) => UserSessionSpaceSummary,
): UserSessionSpaceSummary[] {
	let next: UserSessionSpaceSummary[];
	if (hold && current.length > 0) {
		const byId = new Map(spaces.map((space) => [space.id, space]));
		next = current.map((chip) => {
			const space = byId.get(chip.id);
			return space ? summarize(space) : chip;
		});
	} else {
		next = spaces
			.filter((space) => !space.isArchived)
			.slice(0, SPACE_CHIP_LIMIT)
			.map(summarize);
	}
	return sameData(current, next) ? current : next;
}
