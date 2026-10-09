import {
	readSentTurns,
	readSessionTurnOrigin,
	type SentTurnRef,
	type SessionTurnRecord,
} from "@cohub/protocol/model";

export type RelatedSessionRef = { spaceId: string; sessionId: string };

export type SentSession = RelatedSessionRef & { count: number };

export type SentTurnIndex = {
	key: string;
	byCallerTurn: ReadonlyMap<string, readonly SentSession[]>;
	byToolCall: ReadonlyMap<string, readonly SentSession[]>;
};

export const NO_SENT_SESSIONS: readonly SentSession[] = [];

export const EMPTY_SENT_TURNS: SentTurnIndex = {
	key: "",
	byCallerTurn: new Map(),
	byToolCall: new Map(),
};

function groupBySession(
	refs: readonly SentTurnRef[],
	fallbackSpaceId: string,
): SentSession[] {
	const sessions = new Map<string, SentSession>();
	for (const ref of refs) {
		const spaceId = ref.spaceId ?? fallbackSpaceId;
		const key = `${spaceId}:${ref.sessionId}`;
		const current = sessions.get(key);
		if (current) current.count += 1;
		else sessions.set(key, { spaceId, sessionId: ref.sessionId, count: 1 });
	}
	return [...sessions.values()];
}

export function buildSentTurnIndex(
	turns: readonly SessionTurnRecord[],
	spaceId: string | null,
	previous: SentTurnIndex = EMPTY_SENT_TURNS,
): SentTurnIndex {
	if (!spaceId || turns.length === 0) return EMPTY_SENT_TURNS;
	const fanOut: Array<[turnId: string, refs: SentTurnRef[]]> = [];
	let key = "";
	for (const turn of turns) {
		const refs = readSentTurns(turn.meta).filter(
			(ref) => ref.sessionId !== turn.sessionId,
		);
		if (refs.length === 0) continue;
		fanOut.push([turn.id, refs]);
		key += `${turn.id}:${refs.map((ref) => ref.turnId).join(",")};`;
	}
	if (fanOut.length === 0) return EMPTY_SENT_TURNS;
	key = `${spaceId}|${key}`;
	if (previous.key === key) return previous;

	const byCallerTurn = new Map<string, readonly SentSession[]>();
	const byToolCall = new Map<string, SentTurnRef[]>();
	for (const [turnId, refs] of fanOut) {
		byCallerTurn.set(turnId, groupBySession(refs, spaceId));
		for (const ref of refs) {
			if (!ref.toolCallId) continue;
			const own = byToolCall.get(ref.toolCallId);
			if (own) own.push(ref);
			else byToolCall.set(ref.toolCallId, [ref]);
		}
	}
	return {
		key,
		byCallerTurn,
		byToolCall: new Map(
			[...byToolCall].map(([toolCallId, refs]) => [
				toolCallId,
				groupBySession(refs, spaceId),
			]),
		),
	};
}

export function readSentFrom(
	turn: Pick<SessionTurnRecord, "sessionId" | "meta"> | null | undefined,
): RelatedSessionRef | null {
	const origin = turn ? readSessionTurnOrigin(turn.meta) : null;
	if (!turn || !origin || origin.sessionId === turn.sessionId) return null;
	return { spaceId: origin.spaceId, sessionId: origin.sessionId };
}
