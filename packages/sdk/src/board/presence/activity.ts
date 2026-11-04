import { type Actor, type ActorModel, actorKindOf, type RequestSource } from "@cohub/protocol";

const ACTIVE_MS = 1_800;
const VISIBLE_MS = { agent: 8_000, cli: 4_000 } as const;
const MAX_VISIBLE_MS = 30_000;
const MAX_ACTIVITIES = 12;

export type BoardPresenceChange = {
	actorId: string;
	actor?: Actor;
	source?: RequestSource;
	changed: { items: string[] };
};

export type BoardAutomationActivity = {
	id: string;
	actorId: string;
	kind: "agent" | "cli";
	model: ActorModel | null;
	source: RequestSource;
	itemIds: readonly string[];
	startedAt: number;
	updatedAt: number;
};

export function automationActivity(change: BoardPresenceChange, at: number): BoardAutomationActivity | null {
	const { source, actor, actorId } = change;
	if (!source || change.changed.items.length === 0) return null;
	const kind = actor?.kind ?? actorKindOf(source);
	if (kind === "user") return null;
	return {
		id: kind === "agent" && source.toolCallId ? `agent:${source.toolCallId}` : `cli:${actorId}`,
		actorId,
		kind,
		model: actor?.model ?? null,
		source,
		itemIds: change.changed.items,
		startedAt: at,
		updatedAt: at,
	};
}

export function mergeAutomationActivity(
	activities: readonly BoardAutomationActivity[],
	next: BoardAutomationActivity,
): BoardAutomationActivity[] {
	const existing = activities.find((activity) => activity.id === next.id);
	const merged = existing ? { ...next, model: next.model ?? existing.model, startedAt: existing.startedAt } : next;
	return [merged, ...activities.filter((activity) => activity.id !== next.id)].slice(0, MAX_ACTIVITIES);
}

export const activitySettlesAt = (activity: BoardAutomationActivity) => activity.updatedAt + ACTIVE_MS;

export const activityExpiresAt = (activity: BoardAutomationActivity) =>
	Math.min(activity.updatedAt + VISIBLE_MS[activity.kind], activity.startedAt + MAX_VISIBLE_MS);
