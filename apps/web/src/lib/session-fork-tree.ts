import type { SessionRecord } from "@neta-art/cohub";
import { formatResourceMentionTextForDisplay } from "$lib/mentions/resource";
import { getSessionSortTime } from "$lib/session-sort";

export type SessionForkEdge = {
	childSessionId: string;
	parentSessionId?: string | null;
	anchorSequence?: number | null;
	firstUserTextAfterFork?: string | null;
	parentTitle?: string | null;
};

export type SessionTreeItem<T extends SessionRecord = SessionRecord> = {
	session: T;
	fork: SessionForkEdge | null;
	visualDepth: number;
	isLastChild: boolean;
	hasChildren: boolean;
};

const TITLE_LIMIT = 48;

export function normalizeSessionText(value: string | null | undefined) {
	return formatResourceMentionTextForDisplay(value ?? "")
		.replace(/\s+/g, " ")
		.replace(/^[:\-\s]+/, "")
		.trim();
}

export function getSessionListTitle(session: SessionRecord): string | null {
	for (const candidate of [session.title, session.latestMessageText]) {
		const text = normalizeSessionText(candidate);
		if (text) return text.slice(0, TITLE_LIMIT);
	}
	return null;
}

export function getSessionTreeTitle(item: SessionTreeItem): string | null {
	const { session, fork } = item;
	if (fork) {
		const own = normalizeSessionText(session.title);
		const parent = normalizeSessionText(fork.parentTitle);
		const forkText = normalizeSessionText(fork.firstUserTextAfterFork);
		if (forkText && (!own || own === parent))
			return forkText.slice(0, TITLE_LIMIT);
	}
	return getSessionListTitle(session);
}

export function buildSessionForkTree<T extends SessionRecord>(
	sessions: readonly T[],
	forks: readonly SessionForkEdge[] | null | undefined,
): SessionTreeItem<T>[] {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const forkByChild = new Map<string, SessionForkEdge>();
	for (const fork of forks ?? []) {
		const parentId = fork.parentSessionId;
		if (!parentId || parentId === fork.childSessionId || !byId.has(parentId))
			continue;
		if (byId.has(fork.childSessionId))
			forkByChild.set(fork.childSessionId, fork);
	}

	const children = new Map<string, T[]>();
	const roots: T[] = [];
	for (const session of sessions) {
		const parentId = forkByChild.get(session.id)?.parentSessionId;
		if (!parentId) {
			roots.push(session);
			continue;
		}
		const siblings = children.get(parentId);
		if (siblings) siblings.push(session);
		else children.set(parentId, [session]);
	}

	const groupTime = new Map<string, number>();
	const timeOf = (session: T, trail: Set<string>): number => {
		const cached = groupTime.get(session.id);
		if (cached !== undefined) return cached;
		let time = getSessionSortTime(session);
		if (!trail.has(session.id)) {
			trail.add(session.id);
			for (const child of children.get(session.id) ?? [])
				time = Math.max(time, timeOf(child, trail));
			trail.delete(session.id);
		}
		groupTime.set(session.id, time);
		return time;
	};
	const compare = (a: T, b: T) =>
		timeOf(b, new Set()) - timeOf(a, new Set()) || b.id.localeCompare(a.id);

	const items: SessionTreeItem<T>[] = [];
	const placed = new Set<string>();
	const append = (session: T, visualDepth: number, isLastChild: boolean) => {
		if (placed.has(session.id)) return;
		placed.add(session.id);
		const kids = (children.get(session.id) ?? []).sort(compare);
		items.push({
			session,
			fork: visualDepth > 0 ? (forkByChild.get(session.id) ?? null) : null,
			visualDepth,
			isLastChild,
			hasChildren: kids.length > 0,
		});
		kids.forEach((child, index) => {
			append(child, visualDepth + 1, index === kids.length - 1);
		});
	};
	for (const root of roots.sort(compare)) append(root, 0, false);
	for (const session of sessions) append(session, 0, false);
	return items;
}
