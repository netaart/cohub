import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type { SessionRecord, SessionTurnRecord } from "@neta-art/cohub";
import { mergeSessionRecord } from "$lib/session-record-merge";

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
	const live = turn.status === "running" || turn.status === "abort_requested";
	const queued = turn.status === "queued";
	if (active) {
		if (active.id !== turn.id) {
			const candidateRank = queued ? 1 : 0;
			const activeRank = active.status === "queued" ? 1 : 0;
			const replaces =
				(live || queued) &&
				(candidateRank < activeRank ||
					(candidateRank === activeRank && sequence < active.sequence));
			if (!replaces) return session;
		}
	}
	if (
		!active &&
		(live || queued) &&
		sequence <= (session.activeTurnSequence ?? 0)
	)
		return session;
	const patch: Partial<SessionRecord> = {
		activeTurnSequence: sequence,
		activeTurn:
			live || queued
				? {
						id: turn.id,
						sequence,
						status: turn.status as NonNullable<
							SessionRecord["activeTurn"]
						>["status"],
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
			turn.status === "failed" || turn.status === "interrupted"
				? {
						turnId: turn.id,
						sequence,
						status: turn.status,
						reason: turn.summary?.reason ?? null,
						errorMessage: turn.errorMessage ?? null,
					}
				: null,
	};
	return mergeSessionRecord(session, { ...session, ...patch }) as T;
}
