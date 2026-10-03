import {
	readSentTurns,
	readSessionTurnOrigin,
	type SentTurnRef,
	type SessionTurnRecord,
} from "@cohub/protocol/model";

/**
 * Cross-Session prompting from the caller's side: `meta.messagesSent` on the
 * caller pairs with `meta.origin` on the child. Both come from already-loaded
 * Turns, so no extra request and no child title stored on the Turn.
 */
export type SentTurnLink = SentTurnRef & {
	callerTurnId: string;
	title: string | null;
};

export type SentTurnIndex = {
	links: SentTurnLink[];
	byCallerTurn: Map<string, SentTurnLink[]>;
	byToolCallId: Map<string, SentTurnLink>;
};

/** Shared empty value so components can default props without allocating. */
export const EMPTY_SENT_TURNS: SentTurnIndex = {
	links: [],
	byCallerTurn: new Map(),
	byToolCallId: new Map(),
};

export function buildSentTurnIndex(
	turns: readonly SessionTurnRecord[],
	spaceId: string | null,
): SentTurnIndex {
	if (turns.length === 0 || !spaceId) return EMPTY_SENT_TURNS;
	const links: SentTurnLink[] = [];
	const byCallerTurn = new Map<string, SentTurnLink[]>();
	const byTurnId = new Map<string, SentTurnLink>();
	for (const turn of turns) {
		const refs = readSentTurns(turn.meta);
		if (refs.length === 0) continue;
		const own = refs.map(
			(ref): SentTurnLink => ({ ...ref, callerTurnId: turn.id, title: null }),
		);
		links.push(...own);
		byCallerTurn.set(turn.id, own);
		for (const link of own) byTurnId.set(link.turnId, link);
	}
	if (links.length === 0) return EMPTY_SENT_TURNS;
	const byToolCallId = new Map<string, SentTurnLink>();
	for (const turn of turns) {
		const origin = readSessionTurnOrigin(turn.meta, spaceId);
		if (!origin?.toolCallId) continue;
		const link = byTurnId.get(turn.id);
		if (link) byToolCallId.set(origin.toolCallId, link);
	}
	return { links, byCallerTurn, byToolCallId };
}

export const sentTurnsForTurn = (
	index: SentTurnIndex,
	turn: SessionTurnRecord | null | undefined,
): SentTurnLink[] => (turn ? (index.byCallerTurn.get(turn.id) ?? []) : []);

export const sentTurnForToolCall = (
	index: SentTurnIndex,
	toolCallId: string,
): SentTurnLink | null => index.byToolCallId.get(toolCallId) ?? null;

/**
 * Applies child titles read from the Session detail cache. A miss stays an id
 * rather than fetching a Session the user is not looking at. Kept free of cache
 * and SDK imports so the projection stays testable under plain Node.
 */
export function applySentTurnTitles(
	index: SentTurnIndex,
	titles: ReadonlyMap<string, string | null>,
): SentTurnIndex {
	if (index.links.length === 0 || titles.size === 0) return index;
	const links = index.links.map((link) => {
		const title = titles.get(link.sessionId) ?? null;
		return title === link.title ? link : { ...link, title };
	});
	if (links.every((link, position) => link === index.links[position])) {
		return index;
	}
	const byCallerTurn = new Map<string, SentTurnLink[]>();
	const byTurnId = new Map<string, SentTurnLink>();
	for (const link of links) {
		const own = byCallerTurn.get(link.callerTurnId);
		if (own) own.push(link);
		else byCallerTurn.set(link.callerTurnId, [link]);
		byTurnId.set(link.turnId, link);
	}
	const byToolCallId = new Map<string, SentTurnLink>();
	for (const [toolCallId, link] of index.byToolCallId) {
		const updated = byTurnId.get(link.turnId);
		if (updated) byToolCallId.set(toolCallId, updated);
	}
	return { links, byCallerTurn, byToolCallId };
}
