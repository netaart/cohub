import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type { SessionRecord, SessionTurnRecord } from "@neta-art/cohub";
import { sameData } from "$lib/lists/live-list-core";
import { TURN_PHASE, turnAdvances, turnPhase } from "$lib/session-record-merge";

type ActiveTurn = NonNullable<SessionRecord["activeTurn"]>;

export function readSessionTurnState(
	event: ChannelEnvelope,
): Partial<SessionTurnRecord> | null {
	if (
		![
			"session.turn.created",
			"session.turn.updated",
			"session.turn.finalized",
		].includes(event.type)
	)
		return null;
	const turn = (event.payload as { turn?: Partial<SessionTurnRecord> }).turn;
	return turn &&
		typeof turn.id === "string" &&
		turn.sessionId === event.sessionId &&
		typeof turn.sequence === "number" &&
		typeof turn.status === "string"
		? turn
		: null;
}

export function mergeSessionTurnState<T extends SessionRecord>(
	session: T,
	turn: Partial<SessionTurnRecord>,
): T {
	if (
		!turn.id ||
		turn.sessionId !== session.id ||
		!Number.isInteger(turn.sequence) ||
		!turn.status
	)
		return session;
	const active = session.activeTurn;
	const sequence = turn.sequence as number;
	const status = turn.status;
	const phase = turnPhase(status);
	const open = phase !== TURN_PHASE.settled;
	if (active?.id === turn.id) {
		if (!turnAdvances(active, { status, updatedAt: turn.updatedAt }))
			return session;
	} else if (active) {
		const shown = turnPhase(active.status);
		const replaces =
			open &&
			(phase > shown || (phase === shown && sequence < active.sequence));
		if (!replaces) return session;
	} else if (sequence < (session.activeTurnSequence ?? 0)) {
		return session;
	} else if (open && sequence === session.activeTurnSequence) {
		return session;
	}
	const next: T = {
		...session,
		activeTurnSequence: sequence,
		activeTurn: open
			? {
					id: turn.id,
					sequence,
					status: status as ActiveTurn["status"],
					provider: turn.provider ?? active?.provider ?? null,
					model: turn.model ?? active?.model ?? null,
					startedAt: turn.startedAt ?? active?.startedAt ?? null,
					updatedAt: turn.updatedAt ?? active?.updatedAt ?? null,
					anchorUserMessageId:
						typeof turn.meta?.userMessageId === "string"
							? turn.meta.userMessageId
							: (active?.anchorUserMessageId ?? null),
				}
			: null,
		lastTurnIssue:
			status === "failed" || status === "interrupted"
				? {
						turnId: turn.id,
						sequence,
						status,
						reason: turn.summary?.reason ?? null,
						errorMessage: turn.errorMessage ?? null,
					}
				: null,
	};
	return sameData(session, next) ? session : next;
}
