import type { SessionTurnRecord } from "@cohub/protocol/model";
import type {
	PaletteOverviewResponse,
	PaletteOverviewSession,
	PaletteOverviewSpace,
	SessionRecord,
	SpaceRecord,
} from "@neta-art/cohub";
import {
	idbGetAllByIndex,
	idbGetSomeByIndex,
	type SessionListCacheRecord,
	type SessionTurnsCacheRecord,
	type SpaceRecordCacheRecord,
} from "$lib/cache/db";
import { getCacheUserKey } from "$lib/cache/keys";
import { getSpacePublicProfile } from "$lib/space-profile";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { getRecentSpaces } from "$lib/stores/recent-space";
import { getCachedSpaceList } from "$lib/stores/space-list-cache";
import { commandItemKey } from "./merge-results";
import { buildLocalPaletteOverview } from "./palette-overview-local";
import { getViewerTurnActivityBySpace } from "./personal-activity";
import { allowsResourceType, type CommandPaletteSearchPlan } from "./scope";
import { recencyScore } from "./score";
import type { CommandPaletteItem } from "./types";

const DEFAULT_LIMIT = 30;
const SPACE_DEFAULT_LIMIT = 50;
const DEFAULT_SESSION_LIST_SCAN_LIMIT = 120;
const DEFAULT_TURN_RECORD_SCAN_LIMIT = 80;

function compactText(value: string | null | undefined, limit: number) {
	const text = (value ?? "").replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.length > limit
		? `${text.slice(0, Math.max(0, limit - 1))}…`
		: text;
}

function timeValue(value: string | null | undefined) {
	const time = new Date(value ?? 0).getTime();
	return Number.isFinite(time) ? time : 0;
}

function timestampValue(value: number | null | undefined) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isoTimestampValue(value: string | null | undefined) {
	if (!value) return 0;
	const time = new Date(value).getTime();
	return Number.isFinite(time) ? time : 0;
}

function isoFromTimestamp(value: number) {
	return value > 0 ? new Date(value).toISOString() : null;
}

function sessionActivityAt(session: SessionRecord) {
	return (
		session.lastMessageAt ?? session.updatedAt ?? session.createdAt ?? null
	);
}

function spaceActivityAt(space: SpaceRecord) {
	return space.lastActivityAt ?? space.updatedAt ?? space.createdAt ?? null;
}

function newerTime(
	current: string | null | undefined,
	candidate: string | null | undefined,
): string | null {
	return timeValue(candidate) > timeValue(current)
		? (candidate ?? null)
		: (current ?? null);
}

function getSessionActivityBySpace(records: SessionListCacheRecord[]) {
	const activityBySpace = new Map<string, string | null>();
	for (const record of records) {
		let activityAt = record.watermark;
		for (const session of record.sessions) {
			activityAt = newerTime(activityAt, sessionActivityAt(session));
		}
		const current = activityBySpace.get(record.spaceId);
		activityBySpace.set(record.spaceId, newerTime(current, activityAt));
	}
	return activityBySpace;
}

async function getRecentTurnRecords(
	userKey: string,
	options?: { signal?: AbortSignal },
) {
	const records = await idbGetSomeByIndex<SessionTurnsCacheRecord>(
		"session_turns",
		"by_last_accessed",
		IDBKeyRange.lowerBound(0),
		{
			limit: DEFAULT_TURN_RECORD_SCAN_LIMIT,
			direction: "prev",
			filter: (record) => record.userKey === userKey,
		},
	);
	shouldAbort(options?.signal);
	return records.filter((record) => record.userKey === userKey);
}

async function getUserSessionLists(
	userKey: string,
	options?: { signal?: AbortSignal },
) {
	const records = await idbGetSomeByIndex<SessionListCacheRecord>(
		"session_lists",
		"by_updated_at",
		IDBKeyRange.lowerBound(0),
		{
			limit: DEFAULT_SESSION_LIST_SCAN_LIMIT,
			direction: "prev",
			filter: (record) => record.userKey === userKey,
		},
	);
	shouldAbort(options?.signal);
	return records;
}

async function getLocalSpaces(
	userKey: string,
	options?: { signal?: AbortSignal },
) {
	const records = await idbGetAllByIndex<SpaceRecordCacheRecord>(
		"space_records",
		"by_updated_at",
		IDBKeyRange.lowerBound(0),
	);
	shouldAbort(options?.signal);
	const spacesById = new Map<string, SpaceRecord>();
	for (const record of records) {
		if (record.userKey === userKey)
			spacesById.set(record.spaceId, record.space);
	}
	// Prefer the list cache when present: it is refreshed in the background when
	// the palette opens, while per-space IndexedDB records may lag behind briefly.
	for (const space of getCachedSpaceList() ?? [])
		spacesById.set(space.id, space);
	return [...spacesById.values()];
}

/**
 * Overview-shaped synthesis from local caches (IndexedDB + localStorage).
 *
 * Backs the palette's first frame when the cached overview snapshot is stale:
 * same ordering semantics as the server payload (viewer activity),
 * so the list no longer re-sorts from an "all"-ordered fallback once the
 * refetched overview lands.
 */
export async function getLocalPaletteOverview(options?: {
	signal?: AbortSignal;
	viewerUserUuid?: string | null;
}): Promise<PaletteOverviewResponse> {
	const userKey = getCacheUserKey();
	const [spaces, sessionLists, turnRecords] = await Promise.all([
		getLocalSpaces(userKey, options),
		getUserSessionLists(userKey, options),
		getRecentTurnRecords(userKey, options),
	]);
	shouldAbort(options?.signal);
	return buildLocalPaletteOverview({
		spaces,
		sessionLists: sessionLists.map((record) => ({
			spaceId: record.spaceId,
			sessions: record.sessions,
		})),
		turnRecords,
		viewerUserUuid: options?.viewerUserUuid ?? null,
	});
}

function defaultItemsLimit(
	plan: Pick<CommandPaletteSearchPlan, "resourceTypes">,
) {
	return plan.resourceTypes?.length === 1 && plan.resourceTypes[0] === "space"
		? SPACE_DEFAULT_LIMIT
		: DEFAULT_LIMIT;
}

function defaultScore(rank: number, updatedAt: string | null | undefined) {
	const fresh = recencyScore(updatedAt);
	return {
		score: Math.max(0.2, 0.92 - rank * 0.012) * 0.72 + fresh * 0.28,
		textScore: 0,
		recencyScore: fresh,
	};
}

/** Overview space: rank mirrors the personal-activity order. */
function overviewSpaceToItem(
	space: PaletteOverviewSpace,
	rank: number,
	personalActivityAt?: string | null,
): CommandPaletteItem {
	// The displayed timestamp is the same folded personal activity time used
	// for ordering (visits + viewer-owned sessions + server participation),
	// falling back to the server timestamps for spaces with no viewer activity.
	const displayUpdatedAt =
		personalActivityAt ?? space.lastParticipatedAt ?? space.updatedAt;
	const score = defaultScore(rank, displayUpdatedAt);
	return {
		type: "space",
		id: space.id,
		spaceId: space.id,
		sessionId: null,
		turnId: null,
		sequence: null,
		title: space.name ?? "Untitled space",
		excerpt: compactText(space.description, 220),
		spaceName: space.name ?? null,
		ownerProfile: space.ownerProfile ?? null,
		spaceProfile: space.spaceProfile ?? null,
		sessionTitle: null,
		matchedField: "name",
		href: buildSpaceLandingRoute(space.id),
		updatedAt: displayUpdatedAt,
		source: "default",
		localScore: score.score,
		isPinned: space.isPinned,
		isArchived: space.isArchived,
		typePriorityScore: 0.88,
		...score,
	};
}

/** Recently creator/participant session from the overview payload. */
function overviewSessionToItem(
	session: PaletteOverviewSession,
	rank: number,
): CommandPaletteItem {
	const title = session.title || "Untitled session";
	const updatedAt = session.updatedAt;
	const score = defaultScore(rank, updatedAt);
	return {
		type: "session",
		id: session.id,
		spaceId: session.spaceId,
		sessionId: session.id,
		turnId: null,
		sequence: null,
		title,
		excerpt: null,
		spaceName: session.spaceName ?? null,
		sessionTitle: title,
		matchedField: "title",
		href: `/spaces/${session.spaceId}/sessions/${session.id}`,
		updatedAt,
		source: "default",
		localScore: score.score,
		typePriorityScore: 0.74,
		...score,
	};
}

function spaceToDefaultItem(
	space: SpaceRecord,
	rank: number,
	currentSpaceId?: string | null,
	activityAt?: string | null,
): CommandPaletteItem {
	const updatedAt = activityAt ?? spaceActivityAt(space);
	const score = defaultScore(rank, updatedAt);
	return {
		type: "space",
		id: space.id,
		spaceId: space.id,
		sessionId: null,
		turnId: null,
		sequence: null,
		title: space.name ?? "Untitled space",
		excerpt: compactText(space.description, 220),
		spaceName: space.name ?? null,
		ownerProfile: space.ownerProfile ?? null,
		spaceProfile: getSpacePublicProfile(space),
		sessionTitle: null,
		matchedField: "name",
		href: buildSpaceLandingRoute(space.id),
		updatedAt,
		source: "default",
		localScore: score.score,
		isPinned: space.isPinned ?? false,
		isArchived: space.isArchived ?? false,
		typePriorityScore: currentSpaceId === space.id ? 0.93 : 0.88,
		...score,
	};
}

function sessionToDefaultItem(
	session: SessionRecord,
	spaceName: string | null,
	rank: number,
): CommandPaletteItem {
	const title = session.title || "Untitled session";
	const updatedAt =
		session.lastMessageAt ?? session.updatedAt ?? session.createdAt ?? null;
	const score = defaultScore(rank, updatedAt);
	return {
		type: "session",
		id: session.id,
		spaceId: session.spaceId,
		sessionId: session.id,
		turnId: null,
		sequence: null,
		title,
		excerpt: null,
		spaceName,
		sessionTitle: title,
		matchedField: "title",
		href: `/spaces/${session.spaceId}/sessions/${session.id}`,
		updatedAt,
		source: "default",
		localScore: score.score,
		typePriorityScore: 0.74,
		...score,
	};
}

function turnToDefaultItem(input: {
	turn: SessionTurnRecord;
	session: SessionRecord | null;
	spaceId: string;
	spaceName: string | null;
	rank: number;
}): CommandPaletteItem | null {
	const text = input.turn.userText ?? "";
	const title = compactText(text, 140);
	if (!title) return null;
	const updatedAt = input.turn.updatedAt ?? input.turn.createdAt ?? null;
	const score = defaultScore(input.rank, updatedAt);
	return {
		type: "turn",
		id: input.turn.id,
		spaceId: input.spaceId,
		sessionId: input.turn.sessionId,
		turnId: input.turn.id,
		sequence: input.turn.sequence,
		title,
		excerpt: compactText(text, 260),
		spaceName: input.spaceName,
		sessionTitle: input.session?.title ?? null,
		matchedField: "userText",
		href: `/spaces/${input.spaceId}/sessions/${input.turn.sessionId}?turn=${input.turn.sequence}`,
		updatedAt,
		source: "default",
		localScore: score.score,
		typePriorityScore: 0.66,
		...score,
	};
}

function shouldAbort(signal?: AbortSignal) {
	if (signal?.aborted)
		throw new DOMException("Default items aborted", "AbortError");
}

async function yieldToUi() {
	await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

/** Overview path: server-ranked spaces + recent personal sessions + local turns. */
async function buildOverviewDefaultItems(
	plan: CommandPaletteSearchPlan & {
		currentSpaceId?: string | null;
		signal?: AbortSignal;
		viewerUserUuid?: string | null;
	},
	overview: PaletteOverviewResponse,
): Promise<CommandPaletteItem[]> {
	shouldAbort(plan.signal);
	const userKey = getCacheUserKey();
	const spaceNameById = new Map(
		overview.spaces.map((space) => [space.id, space.name ?? null]),
	);
	const items: CommandPaletteItem[] = [];
	let recentTurnRecords: SessionTurnsCacheRecord[] | null = null;
	const getRecentTurns = async () => {
		if (recentTurnRecords) return recentTurnRecords;
		recentTurnRecords = await getRecentTurnRecords(userKey, {
			signal: plan.signal,
		});
		return recentTurnRecords;
	};

	if (allowsResourceType(plan, "space")) {
		// Fold device-local personal signals into the server ranking:
		//  1. recent-space visits (opening a space floats it to the top), and
		//  2. activity of turns authored by the viewer from the local turn cache
		//     (other participants never count).
		const recentActivityBySpace = new Map(
			getRecentSpaces(userKey).map((entry) => [entry.spaceId, entry.timestamp]),
		);
		const viewerSessionActivityBySpace = plan.viewerUserUuid
			? getViewerTurnActivityBySpace(
					await getRecentTurns(),
					plan.viewerUserUuid,
				)
			: new Map<string, string>();
		const personalActivityMs = (space: PaletteOverviewSpace) =>
			Math.max(
				isoTimestampValue(space.lastParticipatedAt),
				timestampValue(recentActivityBySpace.get(space.id)),
				isoTimestampValue(viewerSessionActivityBySpace.get(space.id)),
			);
		// Strictly personal-activity ordering. No pinned tier, no score, no
		// relation tie-breaks — a just-opened space must sit above anything I
		// last touched earlier.
		[...overview.spaces]
			.sort((a, b) => personalActivityMs(b) - personalActivityMs(a))
			.forEach((space, index) => {
				const personalMs = personalActivityMs(space);
				items.push(
					overviewSpaceToItem(
						space,
						index,
						personalMs > 0 ? new Date(personalMs).toISOString() : null,
					),
				);
			});
	}

	if (allowsResourceType(plan, "session")) {
		overview.recentSessions.forEach((session, rank) => {
			items.push(overviewSessionToItem(session, rank));
		});
	}

	if (allowsResourceType(plan, "turn")) {
		await yieldToUi();
		shouldAbort(plan.signal);
		const turnRecords = await getRecentTurns();
		let rank = 0;
		for (const record of [...turnRecords].sort(
			(a, b) => b.lastAccessedAt - a.lastAccessedAt,
		)) {
			const session = record.session ?? null;
			const turns = [...record.turns].sort(
				(a, b) =>
					timeValue(b.updatedAt ?? b.createdAt) -
					timeValue(a.updatedAt ?? a.createdAt),
			);
			for (const turn of turns) {
				const item = turnToDefaultItem({
					turn,
					session,
					spaceId: record.spaceId,
					spaceName: spaceNameById.get(record.spaceId) ?? null,
					rank,
				});
				if (item) items.push(item);
				rank += 1;
				if (rank >= DEFAULT_LIMIT) break;
			}
			if (rank >= DEFAULT_LIMIT) break;
		}
	}

	// Preserve insertion order: spaces (personal activity desc),
	// then recent sessions, then turns. No re-scoring — the ordering above is
	// already the product intent for this list.
	const byKey = new Map<string, CommandPaletteItem>();
	for (const item of items) {
		const key = commandItemKey(item);
		if (!byKey.has(key)) byKey.set(key, item);
	}
	return [...byKey.values()].slice(0, defaultItemsLimit(plan));
}

export async function getCommandPaletteDefaultItems(
	plan: CommandPaletteSearchPlan & {
		currentSpaceId?: string | null;
		signal?: AbortSignal;
		viewerUserUuid?: string | null;
		/** Server-side palette overview — preferred over local-only derivation. */
		paletteOverview?: PaletteOverviewResponse | null;
	},
): Promise<CommandPaletteItem[]> {
	shouldAbort(plan.signal);
	if (plan.paletteOverview) {
		return buildOverviewDefaultItems(plan, plan.paletteOverview);
	}
	const userKey = getCacheUserKey();
	const [localSpaces, sessionListRecords, turnRecords] = await Promise.all([
		getLocalSpaces(userKey, { signal: plan.signal }),
		getUserSessionLists(userKey, { signal: plan.signal }),
		getRecentTurnRecords(userKey, { signal: plan.signal }),
	]);
	shouldAbort(plan.signal);
	const spacesById = new Map(localSpaces.map((space) => [space.id, space]));

	const items: CommandPaletteItem[] = [];

	if (allowsResourceType(plan, "space")) {
		shouldAbort(plan.signal);
		const recentSpaces = getRecentSpaces(userKey);
		const recentRankBySpace = new Map(
			recentSpaces.map((entry, index) => [entry.spaceId, index]),
		);
		const recentActivityBySpace = new Map(
			recentSpaces.map((entry) => [entry.spaceId, entry.timestamp]),
		);
		const activityBySpace = getSessionActivityBySpace(sessionListRecords);
		const effectiveActivityTime = (space: SpaceRecord) =>
			Math.max(
				timeValue(activityBySpace.get(space.id) ?? null),
				timestampValue(recentActivityBySpace.get(space.id)),
				timeValue(spaceActivityAt(space)),
			);
		const orderedSpaces = [...spacesById.values()].sort((a, b) => {
			const activityDelta = effectiveActivityTime(b) - effectiveActivityTime(a);
			if (activityDelta !== 0) return activityDelta;
			if (a.id === plan.currentSpaceId && b.id !== plan.currentSpaceId)
				return -1;
			if (b.id === plan.currentSpaceId && a.id !== plan.currentSpaceId)
				return 1;
			const recentDelta =
				(recentRankBySpace.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
				(recentRankBySpace.get(b.id) ?? Number.MAX_SAFE_INTEGER);
			if (recentDelta !== 0) return recentDelta;
			return timeValue(spaceActivityAt(b)) - timeValue(spaceActivityAt(a));
		});
		orderedSpaces.forEach((space, rank) => {
			const effectiveActivityAt = isoFromTimestamp(
				effectiveActivityTime(space),
			);
			items.push(
				spaceToDefaultItem(
					space,
					rank,
					plan.currentSpaceId,
					effectiveActivityAt,
				),
			);
		});
	}

	if (allowsResourceType(plan, "session") || allowsResourceType(plan, "turn")) {
		await yieldToUi();
		shouldAbort(plan.signal);
		const sessionLists = sessionListRecords;
		const sessionsById = new Map<string, SessionRecord>();
		for (const record of sessionLists) {
			for (const session of record.sessions)
				sessionsById.set(session.id, session);
		}
		if (allowsResourceType(plan, "session")) {
			[...sessionsById.values()]
				.sort(
					(a, b) =>
						timeValue(b.lastMessageAt ?? b.updatedAt ?? b.createdAt) -
						timeValue(a.lastMessageAt ?? a.updatedAt ?? a.createdAt),
				)
				.slice(0, DEFAULT_LIMIT)
				.forEach((session, rank) => {
					items.push(
						sessionToDefaultItem(
							session,
							spacesById.get(session.spaceId)?.name ?? null,
							rank,
						),
					);
				});
		}

		if (allowsResourceType(plan, "turn")) {
			await yieldToUi();
			shouldAbort(plan.signal);
			let rank = 0;
			for (const record of [...turnRecords].sort(
				(a, b) => b.lastAccessedAt - a.lastAccessedAt,
			)) {
				const session =
					record.session ?? sessionsById.get(record.sessionId) ?? null;
				const turns = [...record.turns].sort(
					(a, b) =>
						timeValue(b.updatedAt ?? b.createdAt) -
						timeValue(a.updatedAt ?? a.createdAt),
				);
				for (const turn of turns) {
					const item = turnToDefaultItem({
						turn,
						session,
						spaceId: record.spaceId,
						spaceName: spacesById.get(record.spaceId)?.name ?? null,
						rank,
					});
					if (item) items.push(item);
					rank += 1;
					if (rank >= DEFAULT_LIMIT) break;
				}
				if (rank >= DEFAULT_LIMIT) break;
			}
		}
	}

	// Local commands are injected synchronously by the palette UI so they never
	// wait on IndexedDB / network. Keep this path resource-only.
	const byKey = new Map<string, CommandPaletteItem>();
	for (const item of items) {
		const key = commandItemKey(item);
		if (!byKey.has(key)) byKey.set(key, item);
	}
	return [...byKey.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, defaultItemsLimit(plan));
}
