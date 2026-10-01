import type { RequestSource } from "@cohub/protocol";
import type { BoardDocument, BoardFrame } from "@neta-art/cohub/board";
import { createDocumentLayout, unionRects } from "@neta-art/cohub/board";

export const BOARD_AUTOMATION_ACTIVE_MS = 1_800;
export const BOARD_AGENT_ACTIVITY_MS = 8_000;
export const BOARD_CLI_ACTIVITY_MS = 4_000;
export const BOARD_AUTOMATION_MAX_ACTIVITY_MS = 30_000;
const MAX_ACTIVITIES = 12;

export type BoardCollaboratorProfile = {
	userId: string;
	displayName: string;
	avatarUrl: string | null;
};

export type BoardAutomationActivity = {
	id: string;
	boardId: string;
	actorId: string;
	kind: "cli" | "agent";
	status: "active" | "settled";
	focus: BoardFrame;
	source: RequestSource;
	model: { provider: string | null; id: string } | null;
	startedAt: number;
	updatedAt: number;
};

type ActivityEvent = {
	boardId: string;
	actorId: string;
	txId: string;
	itemIds?: string[];
	source?: RequestSource | null;
	timestamp?: number;
};

export function boardAutomationKind(
	source: RequestSource,
): "cli" | "agent" | null {
	if (source.toolCallId) return "agent";
	return source.via === "cli" ? "cli" : null;
}

export function boardAutomationFocus(
	document: BoardDocument,
	itemIds: string[] = [],
): BoardFrame | null {
	const layout = createDocumentLayout(document.items);
	const focus = unionRects(itemIds.filter((id) => document.items[id]).map((id) => layout.bounds(id)));
	return focus ? { ...focus, rotation: 0 } : null;
}

export function boardAutomationVisibleMs(kind: "cli" | "agent"): number {
	return kind === "agent" ? BOARD_AGENT_ACTIVITY_MS : BOARD_CLI_ACTIVITY_MS;
}

export function boardAutomationExpiresAt(
	activity: Pick<BoardAutomationActivity, "kind" | "startedAt" | "updatedAt">,
): number {
	return Math.min(
		activity.updatedAt + boardAutomationVisibleMs(activity.kind),
		activity.startedAt + BOARD_AUTOMATION_MAX_ACTIVITY_MS,
	);
}

export function createBoardAutomationActivity(
	document: BoardDocument,
	event: ActivityEvent,
	fallbackFocus: BoardFrame | null = null,
): BoardAutomationActivity | null {
	if (!event.source) return null;
	const kind = boardAutomationKind(event.source);
	if (!kind) return null;
	const focus = boardAutomationFocus(document, event.itemIds) ?? fallbackFocus;
	if (!focus) return null;
	const timestamp = event.timestamp ?? Date.now();
	const id =
		kind === "agent" && event.source.toolCallId
			? `agent:${event.boardId}:${event.source.toolCallId}`
			: `cli:${event.boardId}:${event.actorId}`;
	return {
		id,
		boardId: event.boardId,
		actorId: event.actorId,
		kind,
		status: "active",
		focus: { ...focus, rotation: 0 },
		source: event.source,
		model: null,
		startedAt: timestamp,
		updatedAt: timestamp,
	};
}

export function mergeBoardAutomationActivity(
	activities: BoardAutomationActivity[],
	activity: BoardAutomationActivity,
): BoardAutomationActivity[] {
	const existing = activities.find((item) => item.id === activity.id);
	const next = existing
		? {
				...activity,
				model: activity.model ?? existing.model,
				startedAt: existing.startedAt,
			}
		: activity;
	return [next, ...activities.filter((item) => item.id !== activity.id)]
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, MAX_ACTIVITIES);
}
