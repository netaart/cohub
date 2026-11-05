import type { RealtimeSessionFork, SessionRecord } from "@neta-art/cohub";
import { formatResourceMentionTextForDisplay } from "$lib/mentions/resource";
import { getSessionSortTime } from "$lib/session-sort";

export type SessionForkEdge = {
	childSessionId: string;
	parentSessionId?: string | null;
	depth?: number | null;
	anchorSequence?: number | null;
	firstUserTextAfterFork?: string | null;
	parentTitle?: string | null;
};

export const SESSION_TREE_MAX_DEPTH = 4;
/** Fork rows a collapsed group still shows, in display order. */
export const SESSION_FORK_COLLAPSED_ROWS = 3;

export type SessionRowTree = {
	depth: number;
	last: boolean;
	hasChildren: boolean;
	/** Ancestor levels whose rail continues past this row. */
	rails: number[];
};

/** Present on rows with forks when folding is enabled. */
export type SessionForkFold = {
	expanded: boolean;
	hidden: number;
	hiddenUnread: number;
};

export type SessionTreeItem<T extends SessionRecord = SessionRecord> = {
	session: T;
	fork: SessionForkEdge | null;
	tree: SessionRowTree;
	fold?: SessionForkFold;
};

export type SessionForkFoldOptions<T extends SessionRecord> = {
	collapsed: ReadonlySet<string>;
	/** Descendants that stay visible past the first rows of a collapsed group. */
	keep?: (session: T) => boolean;
	unread?: (session: T) => boolean;
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
	fold?: SessionForkFoldOptions<T>,
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

	const rows: { session: T; depth: number; fold?: SessionForkFold }[] = [];
	const placed = new Set<string>();
	const childrenOf = (session: T) =>
		(children.get(session.id) ?? []).sort(compare);
	// A collapsed group shows its first descendant rows plus kept ones; each
	// visible row hangs under its nearest visible ancestor.
	const collapse = (
		session: T,
		depth: number,
		state: SessionForkFold & { seen: number },
	) => {
		for (const child of childrenOf(session)) {
			if (placed.has(child.id)) continue;
			placed.add(child.id);
			const visible =
				state.seen++ < SESSION_FORK_COLLAPSED_ROWS || fold?.keep?.(child);
			if (visible) rows.push({ session: child, depth });
			else {
				state.hidden++;
				if (fold?.unread?.(child)) state.hiddenUnread++;
			}
			collapse(child, visible ? depth + 1 : depth, state);
		}
	};
	// Groups that fit within the collapsed rows have nothing to fold.
	const foldable = (id: string) => {
		const seen = new Set([id]);
		const queue = [id];
		for (const next of queue) {
			for (const child of children.get(next) ?? []) {
				if (seen.has(child.id)) continue;
				if (seen.size > SESSION_FORK_COLLAPSED_ROWS) return true;
				seen.add(child.id);
				queue.push(child.id);
			}
		}
		return false;
	};
	const append = (session: T, depth: number) => {
		if (placed.has(session.id)) return;
		placed.add(session.id);
		const row: (typeof rows)[number] = { session, depth };
		rows.push(row);
		if (fold && foldable(session.id)) {
			row.fold = {
				expanded: !fold.collapsed.has(session.id),
				hidden: 0,
				hiddenUnread: 0,
			};
			if (!row.fold.expanded) {
				const state = { ...row.fold, seen: 0 };
				collapse(session, depth + 1, state);
				row.fold.hidden = state.hidden;
				row.fold.hiddenUnread = state.hiddenUnread;
				return;
			}
		}
		for (const child of childrenOf(session)) append(child, depth + 1);
	};
	for (const root of roots.sort(compare)) append(root, 0);
	for (const session of sessions) append(session, 0);

	// Deeper forks flatten into the last level; rails follow the visible rows.
	const items: SessionTreeItem<T>[] = [];
	const nextAtOrAbove: number[] = [];
	rows.reduceRight((nextDepth, { session, depth: rawDepth, fold }) => {
		const depth = Math.min(rawDepth, SESSION_TREE_MAX_DEPTH);
		items.push({
			session,
			fork: rawDepth > 0 ? (forkByChild.get(session.id) ?? null) : null,
			...(fold && { fold }),
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
