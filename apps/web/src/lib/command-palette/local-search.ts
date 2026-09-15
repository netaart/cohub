import type { SessionTurnRecord } from "@cohub/protocol/model";
import type {
	LabelAssignmentListItem,
	LabelListItem,
	SessionRecord,
	SpaceRecord,
} from "@neta-art/cohub";
import {
	idbGetAllByIndex,
	idbGetSomeByIndex,
	type LabelItemsCacheRecord,
	type LabelTreeCacheRecord,
	type SessionListCacheRecord,
	type SessionTurnsCacheRecord,
	type SpaceRecordCacheRecord,
} from "$lib/cache/db";
import { getCacheUserKey } from "$lib/cache/keys";
import { getSpacePublicProfile } from "$lib/space-profile";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { getCachedSpaceList } from "$lib/stores/space-list-cache";
import { commandItemKey } from "./merge-results";
import { allowsResourceType, type CommandPaletteSearchPlan } from "./scope";
import { scoreCommandItem, sortCommandItems, textMatchScore } from "./score";
import type { CommandPaletteItem, CommandPaletteViewerRelation } from "./types";

const LOCAL_LIMIT = 40;
const LOCAL_SESSION_LIST_SCAN_LIMIT = 120;
const LOCAL_TURN_RECORD_SCAN_LIMIT = 80;

function viewerRelationForSession(
	session:
		| Pick<SessionRecord, "userUuid" | "participantUserUuids">
		| null
		| undefined,
	viewerUserUuid: string | null | undefined,
): CommandPaletteViewerRelation {
	if (!viewerUserUuid || !session) return "unknown";
	if (session.userUuid === viewerUserUuid) return "creator";
	if (session.participantUserUuids?.includes(viewerUserUuid))
		return "participant";
	return "unrelated";
}

export function viewerTierForRelation(
	relation: CommandPaletteViewerRelation | null | undefined,
) {
	if (relation === "creator" || relation === "participant") return 0;
	if (relation === "unrelated") return 2;
	return 1;
}

function hrefFor(
	item: Pick<
		CommandPaletteItem,
		| "type"
		| "spaceId"
		| "sessionId"
		| "sequence"
		| "labelResourceType"
		| "labelResourceRef"
	>,
) {
	if (item.type === "space") return buildSpaceLandingRoute(item.spaceId);
	if (item.type === "session")
		return `/spaces/${item.spaceId}/sessions/${item.sessionId}`;
	if (item.type === "label") {
		if (item.labelResourceType === "session")
			return `/spaces/${item.spaceId}/sessions/${item.labelResourceRef}`;
		if (item.labelResourceType === "checkpoint")
			return `/spaces/${item.spaceId}/checkpoints/${item.labelResourceRef}`;
		if (item.labelResourceType === "file")
			return `/spaces/${item.spaceId}/files/${(item.labelResourceRef ?? "")
				.split("/")
				.map(encodeURIComponent)
				.join("/")}`;
		return buildSpaceLandingRoute(item.spaceId);
	}
	return `/spaces/${item.spaceId}/sessions/${item.sessionId}?turn=${item.sequence}`;
}

function compactText(value: string | null | undefined, limit: number) {
	const text = (value ?? "").replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.length > limit
		? `${text.slice(0, Math.max(0, limit - 1))}…`
		: text;
}

function spaceActivityAt(space: SpaceRecord) {
	return space.lastActivityAt ?? space.updatedAt ?? space.createdAt ?? null;
}

function spaceToItem(
	space: SpaceRecord,
	query: string,
	viewerUserUuid?: string | null,
): CommandPaletteItem | null {
	const nameScore = textMatchScore(space.name, query);
	const descriptionScore = textMatchScore(space.description, query);
	if (Math.max(nameScore, descriptionScore) <= 0) return null;
	const matchedField = nameScore >= descriptionScore ? "name" : "description";
	const activityAt = spaceActivityAt(space);
	const scored = scoreCommandItem({
		type: "space",
		query,
		primary: matchedField === "name" ? space.name : space.description,
		secondary: matchedField === "name" ? space.description : space.name,
		matchedField,
		updatedAt: activityAt,
	});
	const viewerRelation: CommandPaletteViewerRelation | null = viewerUserUuid
		? space.userUuid === viewerUserUuid
			? "creator"
			: "unknown"
		: null;
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
		matchedField,
		href: buildSpaceLandingRoute(space.id),
		updatedAt: activityAt,
		source: "local",
		localScore: scored.score,
		isPinned: space.isPinned ?? false,
		viewerRelation,
		viewerTier: viewerRelation === "creator" ? 0 : 1,
		...scored,
	};
}

function sessionToItem(input: {
	session: SessionRecord;
	spaceName: string | null;
	query: string;
	viewerUserUuid?: string | null;
}): CommandPaletteItem | null {
	const title = input.session.title || "Untitled session";
	if (textMatchScore(title, input.query) <= 0) return null;
	const updatedAt =
		input.session.lastMessageAt ??
		input.session.updatedAt ??
		input.session.createdAt ??
		null;
	const scored = scoreCommandItem({
		type: "session",
		query: input.query,
		primary: title,
		matchedField: "title",
		updatedAt,
	});
	const viewerRelation = viewerRelationForSession(
		input.session,
		input.viewerUserUuid,
	);
	return {
		type: "session",
		id: input.session.id,
		spaceId: input.session.spaceId,
		sessionId: input.session.id,
		turnId: null,
		sequence: null,
		title,
		excerpt: null,
		spaceName: input.spaceName,
		sessionTitle: title,
		matchedField: "title",
		href: `/spaces/${input.session.spaceId}/sessions/${input.session.id}`,
		updatedAt,
		source: "local",
		localScore: scored.score,
		viewerRelation,
		viewerTier: viewerTierForRelation(viewerRelation),
		...scored,
	};
}

type LabelWithRef = LabelListItem & { ref: string };

function normalizeLabelRef(value: string | null | undefined) {
	return (value ?? "")
		.split("/")
		.map((part) => part.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join("/")
		.toLowerCase();
}

function flattenLabelsWithRefs(labels: LabelListItem[]) {
	const result: LabelWithRef[] = [];
	const visit = (items: LabelListItem[], parentRef = "") => {
		for (const label of items) {
			const ref = parentRef ? `${parentRef}/${label.name}` : label.name;
			result.push({ ...label, ref });
			if (label.children?.length) visit(label.children, ref);
		}
	};
	visit(labels);
	return result;
}

function labelItemText(item: LabelAssignmentListItem) {
	return [
		item.resource?.title,
		item.resource?.subtitle,
		item.resource?.status,
		item.resourceRef,
	]
		.filter(Boolean)
		.join(" ");
}

function labelAssignmentToItem(input: {
	assignment: LabelAssignmentListItem;
	label: LabelWithRef;
	spaceName: string | null;
	spaceProfile?: CommandPaletteItem["spaceProfile"];
	query: string;
}): CommandPaletteItem | null {
	const query = input.query.trim();
	const text = labelItemText(input.assignment);
	const textScore = query ? textMatchScore(text, query) : 1;
	if (query && textScore <= 0) return null;
	const updatedAt =
		input.assignment.updatedAt ?? input.assignment.createdAt ?? null;
	const scored = query
		? scoreCommandItem({
				type: "label",
				query,
				primary: text,
				matchedField: "labelItemContent",
				updatedAt,
			})
		: {
				score:
					0.72 +
					Math.min(0.2, (1000 - (input.assignment.rank ?? 1000)) / 10000),
				textScore: 1,
				recencyScore: 0.5,
				typePriorityScore: 0.72,
			};
	const partial = {
		type: "label" as const,
		spaceId: input.assignment.scopeId,
		sessionId:
			input.assignment.resourceType === "session"
				? input.assignment.resourceRef
				: null,
		sequence: null,
		labelResourceType: input.assignment.resourceType,
		labelResourceRef: input.assignment.resourceRef,
	};
	return {
		...partial,
		id: input.assignment.id,
		turnId: null,
		title: input.assignment.resource?.title ?? input.assignment.resourceRef,
		excerpt: compactText(
			input.assignment.resource?.subtitle ?? input.assignment.resourceRef,
			220,
		),
		spaceName: input.spaceName,
		spaceProfile: input.spaceProfile ?? null,
		sessionTitle:
			input.assignment.resourceType === "session"
				? (input.assignment.resource?.title ?? null)
				: null,
		matchedField: query ? "labelItemContent" : "labelName",
		href: hrefFor(partial),
		updatedAt,
		source: "local",
		localScore: scored.score,
		labelRef: input.label.ref,
		labelName: input.label.name,
		...scored,
	};
}

function turnToItem(input: {
	turn: SessionTurnRecord;
	session: SessionRecord | null;
	spaceId: string;
	spaceName: string | null;
	query: string;
	viewerUserUuid?: string | null;
}): CommandPaletteItem | null {
	const text = input.turn.userText ?? "";
	if (textMatchScore(text, input.query) <= 0) return null;
	const updatedAt = input.turn.updatedAt ?? input.turn.createdAt ?? null;
	const scored = scoreCommandItem({
		type: "turn",
		query: input.query,
		primary: text,
		matchedField: "userText",
		updatedAt,
	});
	const viewerRelation = viewerRelationForSession(
		input.session,
		input.viewerUserUuid,
	);
	return {
		type: "turn",
		id: input.turn.id,
		spaceId: input.spaceId,
		sessionId: input.turn.sessionId,
		turnId: input.turn.id,
		sequence: input.turn.sequence,
		title: compactText(text, 140) ?? "User message",
		excerpt: compactText(text, 260),
		spaceName: input.spaceName,
		sessionTitle: input.session?.title ?? null,
		matchedField: "userText",
		href: hrefFor({
			type: "turn",
			spaceId: input.spaceId,
			sessionId: input.turn.sessionId,
			sequence: input.turn.sequence,
		}),
		updatedAt,
		source: "local",
		localScore: scored.score,
		viewerRelation,
		viewerTier: viewerTierForRelation(viewerRelation),
		...scored,
	};
}

function shouldAbort(signal?: AbortSignal) {
	if (signal?.aborted) throw new DOMException("Search aborted", "AbortError");
}

async function yieldToUi() {
	await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

export async function searchLocalCommandItems(
	query: string,
	options?: {
		signal?: AbortSignal;
		resourceTypes?: CommandPaletteSearchPlan["resourceTypes"];
		labelRef?: string;
		viewerUserUuid?: string | null;
	},
): Promise<CommandPaletteItem[]> {
	const normalized = query.trim();
	const plan: CommandPaletteSearchPlan = {
		query: normalized,
		resourceTypes: options?.resourceTypes,
		labelRef: options?.labelRef,
	};
	const includeLabels = allowsResourceType(plan, "label");
	const labelRef = normalizeLabelRef(plan.labelRef);
	if (normalized.length < 2 && !(includeLabels && labelRef)) return [];
	const includeSpaces = allowsResourceType(plan, "space");
	const includeSessions = allowsResourceType(plan, "session");
	const includeTurns = allowsResourceType(plan, "turn");
	const userKey = getCacheUserKey();
	const viewerUserUuid = options?.viewerUserUuid ?? null;
	const spacesById = new Map<string, SpaceRecord>();
	const items: CommandPaletteItem[] = [];

	for (const space of getCachedSpaceList() ?? []) {
		spacesById.set(space.id, space);
		if (includeSpaces) {
			const item = spaceToItem(space, normalized, viewerUserUuid);
			if (item) items.push(item);
		}
	}

	const spaceRecords = await idbGetAllByIndex<SpaceRecordCacheRecord>(
		"space_records",
		"by_updated_at",
		IDBKeyRange.lowerBound(0),
	);
	shouldAbort(options?.signal);
	for (const record of spaceRecords) {
		if (record.userKey !== userKey) continue;
		spacesById.set(record.spaceId, record.space);
		if (includeSpaces) {
			const item = spaceToItem(record.space, normalized, viewerUserUuid);
			if (item) items.push(item);
		}
	}

	const sessionLists = await idbGetSomeByIndex<SessionListCacheRecord>(
		"session_lists",
		"by_updated_at",
		IDBKeyRange.lowerBound(0),
		{
			limit: LOCAL_SESSION_LIST_SCAN_LIMIT,
			direction: "prev",
			filter: (record) => record.userKey === userKey,
		},
	);
	shouldAbort(options?.signal);
	const sessionsById = new Map<string, SessionRecord>();
	let processed = 0;
	for (const record of sessionLists) {
		if (record.userKey !== userKey) continue;
		const spaceName = spacesById.get(record.spaceId)?.name ?? null;
		for (const session of record.sessions) {
			sessionsById.set(session.id, session);
			if (includeSessions) {
				const item = sessionToItem({
					session,
					spaceName,
					query: normalized,
					viewerUserUuid,
				});
				if (item) items.push(item);
			}
		}
		processed += 1;
		if (processed % 10 === 0) {
			shouldAbort(options?.signal);
			await yieldToUi();
		}
	}

	if (includeLabels && labelRef) {
		const labelTrees = await idbGetAllByIndex<LabelTreeCacheRecord>(
			"label_trees",
			"by_updated_at",
			IDBKeyRange.lowerBound(0),
		);
		shouldAbort(options?.signal);
		const labelsBySpaceAndId = new Map<string, LabelWithRef>();
		for (const record of labelTrees) {
			if (record.userKey !== userKey) continue;
			for (const label of flattenLabelsWithRefs(record.labels)) {
				if (
					normalizeLabelRef(label.ref) !== labelRef &&
					normalizeLabelRef(label.name) !== labelRef
				) {
					continue;
				}
				labelsBySpaceAndId.set(`${record.spaceId}:${label.id}`, label);
			}
		}
		if (labelsBySpaceAndId.size > 0) {
			const labelItemRecords = await idbGetAllByIndex<LabelItemsCacheRecord>(
				"label_items",
				"by_updated_at",
				IDBKeyRange.lowerBound(0),
			);
			shouldAbort(options?.signal);
			for (const record of labelItemRecords) {
				if (record.userKey !== userKey) continue;
				const label = labelsBySpaceAndId.get(
					`${record.spaceId}:${record.labelId}`,
				);
				if (!label) continue;
				const space = spacesById.get(record.spaceId);
				for (const assignment of record.items) {
					const item = labelAssignmentToItem({
						assignment,
						label,
						spaceName: space?.name ?? null,
						spaceProfile: space ? getSpacePublicProfile(space) : null,
						query: normalized,
					});
					if (item) items.push(item);
				}
			}
		}
	}

	if (!includeTurns) {
		const byKey = new Map<string, CommandPaletteItem>();
		for (const item of items) {
			const key = commandItemKey(item);
			const existing = byKey.get(key);
			if (!existing || item.score > existing.score) byKey.set(key, item);
		}
		return sortCommandItems([...byKey.values()]).slice(0, LOCAL_LIMIT);
	}

	const turnRecords = await idbGetSomeByIndex<SessionTurnsCacheRecord>(
		"session_turns",
		"by_last_accessed",
		IDBKeyRange.lowerBound(0),
		{
			limit: LOCAL_TURN_RECORD_SCAN_LIMIT,
			direction: "prev",
			filter: (record) => record.userKey === userKey,
		},
	);
	shouldAbort(options?.signal);
	processed = 0;
	for (const record of turnRecords) {
		if (record.userKey !== userKey) continue;
		const spaceName = spacesById.get(record.spaceId)?.name ?? null;
		const session =
			record.session ?? sessionsById.get(record.sessionId) ?? null;
		for (const turn of record.turns) {
			const item = turnToItem({
				turn,
				session,
				spaceId: record.spaceId,
				spaceName,
				query: normalized,
				viewerUserUuid,
			});
			if (item) items.push(item);
		}
		processed += 1;
		if (processed % 6 === 0) {
			shouldAbort(options?.signal);
			await yieldToUi();
		}
	}

	const explicitTurnOnly =
		options?.resourceTypes?.length === 1 && options.resourceTypes[0] === "turn";
	const byKey = new Map<string, CommandPaletteItem>();
	for (const item of explicitTurnOnly
		? items
		: aggregateTurnsBySession(items)) {
		const key = commandItemKey(item);
		const existing = byKey.get(key);
		if (!existing || item.score > existing.score) byKey.set(key, item);
	}
	return sortCommandItems([...byKey.values()]).slice(0, LOCAL_LIMIT);
}

/** Keep one best-scoring turn per session unless the user asked for raw turns. */
function aggregateTurnsBySession(items: CommandPaletteItem[]) {
	const bestBySession = new Map<string, CommandPaletteItem>();
	const rest: CommandPaletteItem[] = [];
	for (const item of items) {
		if (item.type !== "turn" || !item.sessionId) {
			rest.push(item);
			continue;
		}
		const existing = bestBySession.get(item.sessionId);
		if (!existing || item.score > existing.score)
			bestBySession.set(item.sessionId, item);
	}
	return [...rest, ...bestBySession.values()];
}
