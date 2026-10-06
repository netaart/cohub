import type { SessionTurnRecord } from "@cohub/protocol/model";
import type {
	PaletteOverviewResponse,
	PaletteOverviewSession,
	PaletteOverviewSpace,
	SessionRecord,
	SpaceRecord,
} from "@neta-art/cohub";
import { getViewerTurnActivityBySpace } from "./personal-activity";

/**
 * Local synthesis and merging of the palette overview payload.
 *
 * The palette renders its first frame from the last received server payload
 * (the cached overview snapshot) folded with local caches: device visits,
 * viewer-authored turns, and newly cached spaces/sessions are merged on top
 * so the frame tracks what the refetched server response will say. Only when
 * no snapshot exists at all does the palette fall back to a purely local
 * synthesis (same stores the legacy list reads, overview ordering).
 *
 * Keep this module free of `$lib` imports so the synthesis stays testable
 * under plain node.
 */

const DEFAULT_SPACE_LIMIT = 50;
const DEFAULT_SESSION_LIMIT = 20;

export type LocalOverviewSessionList = {
	spaceId: string;
	sessions: SessionRecord[];
};

export type LocalOverviewTurns = {
	spaceId: string;
	turns: Array<Pick<SessionTurnRecord, "userUuid" | "createdAt" | "updatedAt">>;
};

function timeValue(value: string | null | undefined) {
	const time = new Date(value ?? 0).getTime();
	return Number.isFinite(time) ? time : 0;
}

function sessionActivityAt(session: SessionRecord) {
	return (
		session.lastMessageAt ?? session.updatedAt ?? session.createdAt ?? null
	);
}

function spaceUpdatedAt(space: SpaceRecord) {
	return space.lastActivityAt ?? space.updatedAt ?? space.createdAt ?? null;
}

function isViewerSession(session: SessionRecord, viewerUserUuid: string) {
	return (
		session.userUuid === viewerUserUuid ||
		(session.participantUserUuids ?? []).includes(viewerUserUuid)
	);
}

export function buildLocalPaletteOverview(input: {
	spaces: SpaceRecord[];
	sessionLists: LocalOverviewSessionList[];
	turnRecords: LocalOverviewTurns[];
	viewerUserUuid: string | null;
	spaceLimit?: number;
	sessionLimit?: number;
}): PaletteOverviewResponse {
	const spaceLimit = input.spaceLimit ?? DEFAULT_SPACE_LIMIT;
	const sessionLimit = input.sessionLimit ?? DEFAULT_SESSION_LIMIT;
	// Later entries win: callers pass fresher sources (the space list cache)
	// after per-space IndexedDB records.
	const spaceById = new Map<string, SpaceRecord>();
	for (const space of input.spaces) spaceById.set(space.id, space);

	// Server participation semantics: only turns authored by the viewer count
	// (another participant advancing a shared session is not "my" recency).
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

	// Recent sessions mirror the server filter: viewer as creator or
	// participant, ordered by latest activity.
	const sessionsById = new Map<string, PaletteOverviewSession>();
	if (input.viewerUserUuid) {
		for (const list of input.sessionLists) {
			const spaceName = spaceById.get(list.spaceId)?.name ?? null;
			for (const session of list.sessions) {
				if (!isViewerSession(session, input.viewerUserUuid)) continue;
				if (sessionsById.has(session.id)) continue;
				sessionsById.set(session.id, {
					id: session.id,
					spaceId: list.spaceId,
					spaceName,
					title: session.title || null,
					viewerRelation:
						session.userUuid === input.viewerUserUuid
							? "creator"
							: "participant",
					lastMessageAt: session.lastMessageAt ?? null,
					updatedAt: sessionActivityAt(session),
				});
			}
		}
	}
	const recentSessions = [...sessionsById.values()]
		.sort((a, b) => timeValue(b.updatedAt) - timeValue(a.updatedAt))
		.slice(0, sessionLimit);

	return {
		generatedAt: new Date().toISOString(),
		spaces: spaces.slice(0, spaceLimit),
		recentSessions,
	};
}

/**
 * Fold a locally synthesized overview into the last received server payload.
 *
 * The snapshot carries server-side truth (cross-device participation times,
 * the full recent-session set) that local caches cannot know; the local pass
 * carries what happened since (new pins, newer participation, new spaces and
 * sessions). The merged view is the closest local approximation of the
 * refetched response, so swapping it in later does not re-sort the list.
 */
export function mergeLocalOverviewIntoSnapshot(
	snapshot: PaletteOverviewResponse,
	local: PaletteOverviewResponse,
): PaletteOverviewResponse {
	// Snapshot fields win on conflicts; the local pass only contributes
	// fresher signals and entries the snapshot has never seen.
	const spacesById = new Map(snapshot.spaces.map((space) => [space.id, space]));
	for (const localSpace of local.spaces) {
		const snap = spacesById.get(localSpace.id);
		if (!snap) {
			spacesById.set(localSpace.id, localSpace);
			continue;
		}
		spacesById.set(localSpace.id, {
			...snap,
			// Pinning is an explicit user action — keep either signal so an
			// unpinned stale cache cannot drop the marker mid-session.
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

	const sessionsById = new Map(
		snapshot.recentSessions.map((session) => [session.id, session]),
	);
	for (const localSession of local.recentSessions) {
		const snap = sessionsById.get(localSession.id);
		if (
			!snap ||
			timeValue(localSession.updatedAt) > timeValue(snap.updatedAt)
		) {
			sessionsById.set(localSession.id, localSession);
		}
	}
	const recentSessions = [...sessionsById.values()]
		.sort((a, b) => timeValue(b.updatedAt) - timeValue(a.updatedAt))
		.slice(0, DEFAULT_SESSION_LIMIT);

	return {
		generatedAt: snapshot.generatedAt,
		spaces: [...spacesById.values()],
		recentSessions,
	};
}
