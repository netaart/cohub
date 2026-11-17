import { HttpError, type SpaceRecord } from "@neta-art/cohub";
import { sdk } from "#lib/sdk.ts";
import { getSpacePublicProfile } from "#lib/space-profile.ts";
import {
	cacheSpaceRecordSoon,
	getCachedSpaceRecord,
} from "#lib/stores/space-record-cache.ts";
import {
	buildSpaceMentionHref,
	buildSpaceMentionUri,
	type SpaceMentionSuggestion,
} from "./space.ts";

// https://cohub.live/tzwm/cohub
const OFFICIAL_SPACE_ID = "cf327f11-5065-4f3a-bfe5-cdb0a70f3377";

let refresh: Promise<SpaceRecord | null> | null = null;

function refreshOfficialSpace() {
	refresh ??= sdk.spaces.get(OFFICIAL_SPACE_ID).then(
		(space) => {
			cacheSpaceRecordSoon(space);
			return space;
		},
		(error) => {
			const settled =
				error instanceof HttpError &&
				(error.status === 403 || error.status === 404);
			if (!settled) refresh = null;
			return null;
		},
	);
	return refresh;
}

function toOfficialMention(space: SpaceRecord): SpaceMentionSuggestion {
	return {
		type: "space",
		id: space.id,
		spaceId: space.id,
		name: space.name ?? space.title ?? "",
		description: space.description ?? null,
		ownerProfile: space.ownerProfile ?? null,
		spaceProfile: getSpacePublicProfile(space),
		href: buildSpaceMentionHref(space.id),
		uri: buildSpaceMentionUri(space.id),
		activityAt: space.lastActivityAt ?? space.updatedAt ?? null,
		source: "local",
		score: 0,
		textScore: 0,
		recencyScore: 0,
		typePriorityScore: 0,
		official: true,
	};
}

export async function loadOfficialSpaceMention(): Promise<SpaceMentionSuggestion | null> {
	const refreshing = refreshOfficialSpace();
	const cached = await getCachedSpaceRecord(OFFICIAL_SPACE_ID).catch(
		() => null,
	);
	const space = cached?.space ?? (await refreshing);
	return space ? toOfficialMention(space) : null;
}
