import type { RealtimeSessionFork, SessionRecord } from "@neta-art/cohub";
import { formatResourceMentionTextForDisplay } from "$lib/mentions/resource";
import {
	compareSessionsByRecentActivity,
	getSessionSortTime,
} from "$lib/session-sort";

export type SessionForkEdge = {
	childSessionId: string;
	parentSessionId?: string | null;
	depth?: number | null;
	anchorSequence?: number | null;
	firstUserTextAfterFork?: string | null;
	parentTitle?: string | null;
};

export const SESSION_TREE_MAX_DEPTH = 4;

export type SessionRowTree = {
	depth: number;
	last: boolean;
	hasChildren: boolean;
	/** Ancestor levels whose rail continues past this row. */
	rails: number[];
};

export type SessionTreeItem<T extends SessionRecord = SessionRecord> = {
	session: T;
	fork: SessionForkEdge | null;
	tree: SessionRowTree;
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

function forkSignature(fork: SessionForkEdge) {
	return [
		fork.parentSessionId ?? "",
		fork.depth ?? 0,
		fork.anchorSequence ?? "",
		fork.parentTitle ?? "",
		fork.firstUserTextAfterFork ?? "",
	].join("|");
}

// Missing or empty input is "unknown", never "clear": partial sources can't drop the tree.
export function mergeSessionForks<T extends SessionForkEdge>(
	current: T[],
	incoming: readonly T[] | null | undefined,
): T[] {
	if (!incoming?.length) return current;
	const byChild = new Map(current.map((fork) => [fork.childSessionId, fork]));
	let changed = false;
	for (const fork of incoming) {
		if (!fork.childSessionId) continue;
		const existing = byChild.get(fork.childSessionId);
		const merged = existing ? { ...existing, ...fork } : fork;
		if (existing && forkSignature(existing) === forkSignature(merged)) continue;
		byChild.set(fork.childSessionId, merged);
		changed = true;
	}
	return changed ? [...byChild.values()] : current;
}

export function readRealtimeSessionFork(
	payload: unknown,
): RealtimeSessionFork | null {
	const fork = (
		payload as { fork?: { [K in keyof RealtimeSessionFork]?: unknown } } | null
	)?.fork;
	if (
		typeof fork?.childSessionId !== "string" ||
		typeof fork.parentSessionId !== "string" ||
		typeof fork.depth !== "number" ||
		typeof fork.anchorSequence !== "number"
	)
		return null;
	return {
		childSessionId: fork.childSessionId,
		parentSessionId: fork.parentSessionId,
		depth: fork.depth,
		anchorSequence: fork.anchorSequence,
	};
}

export function buildSessionForkTree<T extends SessionRecord>(
	sessions: readonly T[],
	forks: readonly SessionForkEdge[] | null | undefined,
): SessionTreeItem<T>[] {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const forkByChild = new Map<string, SessionForkEdge>();
	for (const fork of forks ?? []) {
		const parentId = fork.parentSessionId;
		const parent = parentId ? byId.get(parentId) : undefined;
		if (!parent || parentId === fork.childSessionId) continue;
		if (!byId.has(fork.childSessionId)) continue;
		forkByChild.set(
			fork.childSessionId,
			fork.parentTitle == null && parent.title
				? { ...fork, parentTitle: parent.title }
				: fork,
		);
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

	const rows: { session: T; depth: number }[] = [];
	const placed = new Set<string>();
	// The last level holds every deeper descendant as one flat list, newest first.
	const childrenOf = (session: T, depth: number): T[] => {
		if (depth >= SESSION_TREE_MAX_DEPTH) return [];
		if (depth < SESSION_TREE_MAX_DEPTH - 1)
			return (children.get(session.id) ?? []).sort(compare);
		const flat: T[] = [];
		const seen = new Set([session.id]);
		const visit = (id: string) => {
			for (const child of children.get(id) ?? []) {
				if (seen.has(child.id)) continue;
				seen.add(child.id);
				flat.push(child);
				visit(child.id);
			}
		};
		visit(session.id);
		return flat.sort(compareSessionsByRecentActivity);
	};
	const append = (session: T, depth: number) => {
		if (placed.has(session.id)) return;
		placed.add(session.id);
		rows.push({ session, depth });
		for (const child of childrenOf(session, depth)) append(child, depth + 1);
	};
	for (const root of roots.sort(compare)) append(root, 0);
	for (const session of sessions) append(session, 0);

	// Deeper forks flatten into the last level; rails follow the visible rows.
	const items: SessionTreeItem<T>[] = [];
	const nextAtOrAbove: number[] = [];
	rows.reduceRight((nextDepth, { session, depth: rawDepth }) => {
		const depth = Math.min(rawDepth, SESSION_TREE_MAX_DEPTH);
		items.push({
			session,
			fork: rawDepth > 0 ? (forkByChild.get(session.id) ?? null) : null,
			tree: {
				depth,
				last: nextAtOrAbove[depth] !== depth,
				hasChildren: nextDepth > depth,
				rails: Array.from(
					{ length: Math.max(0, depth - 1) },
					(_, i) => i + 1,
				).filter((level) => nextAtOrAbove[level] === level),
			},
		});
		for (let level = depth; level <= SESSION_TREE_MAX_DEPTH; level++)
			nextAtOrAbove[level] = depth;
		return depth;
	}, 0);
	return items.reverse();
}
