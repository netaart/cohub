import type {
	PaletteOverviewResponse,
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
import { chatHref, chatTitle } from "./chat-items";
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

/** Overview-shaped synthesis from local caches, used before the server payload lands. */
export async function getLocalPaletteOverview(options?: {
	signal?: AbortSignal;
	viewerUserUuid?: string | null;
}): Promise<PaletteOverviewResponse> {
	const userKey = getCacheUserKey();
	const [spaces, turnRecords] = await Promise.all([
		getLocalSpaces(userKey, options),
		getRecentTurnRecords(userKey, options),
	]);
	shouldAbort(options?.signal);
	return buildLocalPaletteOverview({
		spaces,
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

function overviewSpaceToItem(
	space: PaletteOverviewSpace,
	rank: number,
	personalActivityAt?: string | null,
): CommandPaletteItem {
	const displayUpdatedAt =
		personalActivityAt ?? space.lastParticipatedAt ?? space.updatedAt;
	const score = defaultScore(rank, displayUpdatedAt);
	return {
		type: "space",
		id: space.id,
		spaceId: space.id,
		sessionId: null,
		title: space.name ?? "Untitled space",
		excerpt: compactText(space.description, 220),
		spaceName: space.name ?? null,
		ownerProfile: space.ownerProfile ?? null,
		spaceProfile: space.spaceProfile ?? null,
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

export function spaceRecordToCommandItem(
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
		title: space.name ?? "Untitled space",
		excerpt: compactText(space.description, 220),
		spaceName: space.name ?? null,
		ownerProfile: space.ownerProfile ?? null,
		spaceProfile: getSpacePublicProfile(space),
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
	space: SpaceRecord | undefined,
	rank: number,
): CommandPaletteItem {
	const updatedAt = sessionActivityAt(session);
	const score = defaultScore(rank, updatedAt);
	return {
		type: "chat",
		id: session.id,
		spaceId: session.spaceId,
		sessionId: session.id,
		title: chatTitle(session),
		excerpt: null,
		spaceName: space?.name ?? null,
		spaceProfile: space ? getSpacePublicProfile(space) : null,
		matchedField: "title",
		href: chatHref(session.spaceId, session.id),
		updatedAt,
		source: "default",
		localScore: score.score,
		typePriorityScore: 0.74,
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
	const items: CommandPaletteItem[] = [];

	if (allowsResourceType(plan, "space")) {
		const recentActivityBySpace = new Map(
			getRecentSpaces(userKey).map((entry) => [entry.spaceId, entry.timestamp]),
		);
		const viewerSessionActivityBySpace = plan.viewerUserUuid
			? getViewerTurnActivityBySpace(
					await getRecentTurnRecords(userKey, { signal: plan.signal }),
					plan.viewerUserUuid,
				)
			: new Map<string, string>();
		const personalActivityMs = (space: PaletteOverviewSpace) =>
			Math.max(
				isoTimestampValue(space.lastParticipatedAt),
				timestampValue(recentActivityBySpace.get(space.id)),
				isoTimestampValue(viewerSessionActivityBySpace.get(space.id)),
			);
		// Strictly by personal activity: a just-opened space goes to the top.
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

	return items.slice(0, defaultItemsLimit(plan));
}

export async function getCommandPaletteDefaultItems(
	plan: CommandPaletteSearchPlan & {
		currentSpaceId?: string | null;
		signal?: AbortSignal;
		viewerUserUuid?: string | null;
		paletteOverview?: PaletteOverviewResponse | null;
	},
): Promise<CommandPaletteItem[]> {
	shouldAbort(plan.signal);
	if (plan.paletteOverview) {
		return buildOverviewDefaultItems(plan, plan.paletteOverview);
	}
	const userKey = getCacheUserKey();
	const [localSpaces, sessionListRecords] = await Promise.all([
		getLocalSpaces(userKey, { signal: plan.signal }),
		getUserSessionLists(userKey, { signal: plan.signal }),
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
				spaceRecordToCommandItem(
					space,
					rank,
					plan.currentSpaceId,
					effectiveActivityAt,
				),
			);
		});
	}

	if (allowsResourceType(plan, "chat")) {
		await yieldToUi();
		shouldAbort(plan.signal);
		const sessionsById = new Map<string, SessionRecord>();
		for (const record of sessionListRecords) {
			for (const session of record.sessions)
				sessionsById.set(session.id, session);
		}
		[...sessionsById.values()]
			.sort(
				(a, b) =>
					timeValue(sessionActivityAt(b)) - timeValue(sessionActivityAt(a)),
			)
			.slice(0, DEFAULT_LIMIT)
			.forEach((session, rank) => {
				items.push(
					sessionToDefaultItem(session, spacesById.get(session.spaceId), rank),
				);
			});
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
