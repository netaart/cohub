import type { SessionTurnRecord } from "@cohub/protocol/model";
import {
	buildSearchExcerpt,
	findSearchMatches,
	toSearchDisplayText,
} from "@cohub/protocol/search";
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
import { chatHref, chatTitle } from "./chat-items";
import { commandItemKey } from "./merge-results";
import { allowsResourceType, type CommandPaletteSearchPlan } from "./scope";
import {
	blendCommandScore,
	scoreCommandItem,
	sortCommandItems,
	textMatchScore,
} from "./score";
import type { CommandPaletteItem, CommandPaletteViewerRelation } from "./types";

const LOCAL_LIMIT = 40;
const LOCAL_SESSION_LIST_SCAN_LIMIT = 120;
const LOCAL_TURN_RECORD_SCAN_LIMIT = 80;
const MESSAGE_WEIGHT = 0.85;

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

function viewerTierForRelation(
	relation: CommandPaletteViewerRelation | null | undefined,
) {
	if (relation === "creator" || relation === "participant") return 0;
	if (relation === "unrelated") return 2;
	return 1;
}

function labelHref(input: {
	spaceId: string;
	labelResourceType: string;
	labelResourceRef: string;
}) {
	if (input.labelResourceType === "session")
		return `/spaces/${input.spaceId}/sessions/${input.labelResourceRef}`;
	if (input.labelResourceType === "checkpoint")
		return `/spaces/${input.spaceId}/checkpoints/${input.labelResourceRef}`;
	if (input.labelResourceType === "file")
		return `/spaces/${input.spaceId}/files/${input.labelResourceRef
			.split("/")
			.map(encodeURIComponent)
			.join("/")}`;
	return buildSpaceLandingRoute(input.spaceId);
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
		title: space.name ?? "Untitled space",
		excerpt: compactText(space.description, 220),
		spaceName: space.name ?? null,
		ownerProfile: space.ownerProfile ?? null,
		spaceProfile: getSpacePublicProfile(space),
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

type ChatMatch = {
	sessionId: string;
	spaceId: string;
	session: SessionRecord | null;
	titleScore: number | null;
	best: { turn: SessionTurnRecord; score: number } | null;
	messageMatches: number;
};

function chatMatchFor(
	matches: Map<string, ChatMatch>,
	sessionId: string,
	spaceId: string,
	session: SessionRecord | null,
) {
	const existing = matches.get(sessionId);
	if (existing) {
		existing.session ??= session;
		return existing;
	}
	const created: ChatMatch = {
		sessionId,
		spaceId,
		session,
		titleScore: null,
		best: null,
		messageMatches: 0,
	};
	matches.set(sessionId, created);
	return created;
}

function chatToItem(input: {
	match: ChatMatch;
	space: SpaceRecord | undefined;
	query: string;
	viewerUserUuid?: string | null;
}): CommandPaletteItem {
	const { match, query } = input;
	const ownTitle = toSearchDisplayText(match.session?.title);
	const excerpt = match.best
		? buildSearchExcerpt(match.best.turn.userText, query)
		: null;
	const hit =
		match.best && excerpt
			? {
					turnId: match.best.turn.id,
					sequence: match.best.turn.sequence,
					excerpt: excerpt.text,
					highlights: excerpt.highlights,
				}
			: null;
	const matchCount = match.messageMatches + (match.titleScore === null ? 0 : 1);
	const messageScore = (match.best?.score ?? 0) * MESSAGE_WEIGHT;
	const updatedAt =
		match.session?.lastMessageAt ??
		match.session?.updatedAt ??
		match.best?.turn.updatedAt ??
		match.best?.turn.createdAt ??
		null;
	const scored = blendCommandScore({
		type: "chat",
		textScore: Math.min(
			1,
			Math.max(match.titleScore ?? 0, messageScore) +
				Math.min(0.05, (matchCount - 1) * 0.01),
		),
		updatedAt,
	});
	const viewerRelation = viewerRelationForSession(
		match.session,
		input.viewerUserUuid,
	);
	const titleHighlights =
		match.titleScore === null ? [] : findSearchMatches(ownTitle, query);
	return {
		type: "chat",
		id: match.sessionId,
		spaceId: match.spaceId,
		sessionId: match.sessionId,
		title: chatTitle(match.session),
		...(titleHighlights.length > 0 ? { titleHighlights } : {}),
		excerpt: null,
		hit,
		matchCount,
		spaceName: input.space?.name ?? null,
		spaceProfile: input.space ? getSpacePublicProfile(input.space) : null,
		matchedField:
			(match.titleScore ?? 0) >= messageScore ? "title" : "userText",
		href: chatHref(match.spaceId, match.sessionId, hit?.sequence),
		updatedAt,
		source: "local",
		localScore: scored.score,
		viewerRelation,
		viewerTier: viewerTierForRelation(viewerRelation),
		...scored,
	};
}

function containmentScore(text: string | null | undefined, query: string) {
	if (!text || findSearchMatches(text, query, 1).length === 0) return null;
	return Math.max(0.74, textMatchScore(text, query));
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
	const { scopeId: spaceId, resourceType, resourceRef } = input.assignment;
	return {
		type: "label",
		id: input.assignment.id,
		spaceId,
		sessionId: resourceType === "session" ? resourceRef : null,
		title: input.assignment.resource?.title ?? resourceRef,
		excerpt: compactText(
			input.assignment.resource?.subtitle ?? resourceRef,
			220,
		),
		spaceName: input.spaceName,
		spaceProfile: input.spaceProfile ?? null,
		matchedField: query ? "labelItemContent" : "labelName",
		href: labelHref({
			spaceId,
			labelResourceType: resourceType,
			labelResourceRef: resourceRef,
		}),
		updatedAt,
		source: "local",
		localScore: scored.score,
		labelRef: input.label.ref,
		labelName: input.label.name,
		labelResourceType: resourceType,
		labelResourceRef: resourceRef,
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
	const includeChats =
		allowsResourceType(plan, "chat") && normalized.length >= 2;
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

	if (includeChats) {
		const matches = new Map<string, ChatMatch>();
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
		for (const record of sessionLists) {
			for (const session of record.sessions)
				sessionsById.set(session.id, session);
		}
		for (const session of sessionsById.values()) {
			const titleScore = containmentScore(
				toSearchDisplayText(session.title),
				normalized,
			);
			if (titleScore === null) continue;
			chatMatchFor(matches, session.id, session.spaceId, session).titleScore =
				titleScore;
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
		let processed = 0;
		for (const record of turnRecords) {
			for (const turn of record.turns) {
				const score = containmentScore(turn.userText, normalized);
				if (score === null) continue;
				const match = chatMatchFor(
					matches,
					record.sessionId,
					record.spaceId,
					record.session ?? sessionsById.get(record.sessionId) ?? null,
				);
				match.messageMatches += 1;
				if (
					!match.best ||
					score > match.best.score ||
					(score === match.best.score &&
						turn.sequence > match.best.turn.sequence)
				)
					match.best = { turn, score };
			}
			processed += 1;
			if (processed % 6 === 0) {
				shouldAbort(options?.signal);
				await yieldToUi();
			}
		}
		for (const match of matches.values()) {
			items.push(
				chatToItem({
					match,
					space: spacesById.get(match.spaceId),
					query: normalized,
					viewerUserUuid,
				}),
			);
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

	const byKey = new Map<string, CommandPaletteItem>();
	for (const item of items) {
		const key = commandItemKey(item);
		const existing = byKey.get(key);
		if (!existing || item.score > existing.score) byKey.set(key, item);
	}
	return sortCommandItems([...byKey.values()]).slice(0, LOCAL_LIMIT);
}
