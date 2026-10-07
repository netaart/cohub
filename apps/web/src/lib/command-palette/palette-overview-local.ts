import type { SessionTurnRecord } from "@cohub/protocol/model";
import type {
	PaletteOverviewResponse,
	PaletteOverviewSpace,
	SpaceRecord,
} from "@neta-art/cohub";
import { getViewerTurnActivityBySpace } from "./personal-activity";

const DEFAULT_SPACE_LIMIT = 50;

export type LocalOverviewTurns = {
	spaceId: string;
	turns: Array<Pick<SessionTurnRecord, "userUuid" | "createdAt" | "updatedAt">>;
};

function timeValue(value: string | null | undefined) {
	const time = new Date(value ?? 0).getTime();
	return Number.isFinite(time) ? time : 0;
}

function spaceUpdatedAt(space: SpaceRecord) {
	return space.lastActivityAt ?? space.updatedAt ?? space.createdAt ?? null;
}

export function buildLocalPaletteOverview(input: {
	spaces: SpaceRecord[];
	turnRecords: LocalOverviewTurns[];
	viewerUserUuid: string | null;
	spaceLimit?: number;
}): PaletteOverviewResponse {
	const spaceLimit = input.spaceLimit ?? DEFAULT_SPACE_LIMIT;
	// Later entries win: callers pass fresher sources last.
	const spaceById = new Map<string, SpaceRecord>();
	for (const space of input.spaces) spaceById.set(space.id, space);

	const participationBySpace = getViewerTurnActivityBySpace(
		input.turnRecords,
		input.viewerUserUuid,
	);

	const spaces: PaletteOverviewSpace[] = [...spaceById.values()].map(
		(space) => ({
			id: space.id,
			name: space.name,
			description: space.description,
			ownerProfile: space.ownerProfile ?? null,
			spaceProfile: null,
			isPinned: space.isPinned ?? false,
			relation:
				space.userUuid && space.userUuid === input.viewerUserUuid
					? "owner"
					: "member",
			lastParticipatedAt: participationBySpace.get(space.id) ?? null,
			updatedAt: spaceUpdatedAt(space),
		}),
	);
	spaces.sort((a, b) => {
		const participationDelta =
			timeValue(b.lastParticipatedAt) - timeValue(a.lastParticipatedAt);
		if (participationDelta !== 0) return participationDelta;
		return timeValue(b.updatedAt) - timeValue(a.updatedAt);
	});

	return {
		generatedAt: new Date().toISOString(),
		spaces: spaces.slice(0, spaceLimit),
	};
}

/** Fold fresher local signals into the last server snapshot; snapshot fields win. */
export function mergeLocalOverviewIntoSnapshot(
	snapshot: PaletteOverviewResponse,
	local: PaletteOverviewResponse,
): PaletteOverviewResponse {
	const spacesById = new Map(snapshot.spaces.map((space) => [space.id, space]));
	for (const localSpace of local.spaces) {
		const snap = spacesById.get(localSpace.id);
		if (!snap) {
			spacesById.set(localSpace.id, localSpace);
			continue;
		}
		spacesById.set(localSpace.id, {
			...snap,
			isPinned: snap.isPinned || localSpace.isPinned,
			lastParticipatedAt:
				timeValue(localSpace.lastParticipatedAt) >
				timeValue(snap.lastParticipatedAt)
					? localSpace.lastParticipatedAt
					: snap.lastParticipatedAt,
			updatedAt:
				timeValue(localSpace.updatedAt) > timeValue(snap.updatedAt)
					? localSpace.updatedAt
					: snap.updatedAt,
		});
	}

	return {
		generatedAt: snapshot.generatedAt,
		spaces: [...spacesById.values()],
	};
}
