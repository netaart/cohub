import {
	readSessionStats,
	sanitizeSessionStatsMeta,
} from "@cohub/protocol/model";
import type { SessionRecord } from "@neta-art/cohub";

function hasOwn<T extends object, K extends PropertyKey>(
	value: T,
	key: K,
): value is T & Record<K, unknown> {
	return Object.hasOwn(value, key);
}

export type SessionRecordInput = Omit<SessionRecord, "meta"> & {
	meta?: SessionRecord["meta"];
	stats?: unknown;
};

type TurnState = Pick<
	SessionRecord,
	"activeTurn" | "activeTurnSequence" | "lastTurnIssue"
>;
type ActiveTurn = NonNullable<SessionRecord["activeTurn"]>;

export const TURN_PHASE = { queued: 0, live: 1, settled: 2 } as const;

export function turnPhase(status: string): number {
	return status === "queued"
		? TURN_PHASE.queued
		: status === "running" || status === "abort_requested"
			? TURN_PHASE.live
			: TURN_PHASE.settled;
}

export function turnAdvances(
	current: Pick<ActiveTurn, "status" | "updatedAt">,
	next: { status: string; updatedAt?: string | null },
) {
	const from = turnPhase(current.status);
	const to = turnPhase(next.status);
	if (from !== to) return to > from;
	return !(
		Date.parse(next.updatedAt ?? "") < Date.parse(current.updatedAt ?? "")
	);
}

function turnMark(state: Partial<TurnState>): [number, number] | null {
	const turn = state.activeTurn;
	if (turn) return [turn.sequence, turnPhase(turn.status)];
	return state.activeTurnSequence == null
		? null
		: [state.activeTurnSequence, TURN_PHASE.settled];
}

// Turn state follows its own lifecycle, never the Session's `updatedAt`.
function acceptsTurnState(
	existing: SessionRecord | undefined | null,
	incoming: SessionRecordInput,
) {
	if (!hasOwn(incoming, "activeTurn")) return false;
	const current = existing ? turnMark(existing) : null;
	if (!current) return true;
	const next = turnMark(incoming);
	if (!next) return false;
	if (next[0] !== current[0]) return next[0] > current[0];
	if (next[1] !== current[1]) return next[1] > current[1];
	const known = existing?.activeTurn;
	const received = incoming.activeTurn;
	return !known || !received || known.id !== received.id
		? true
		: turnAdvances(known, received);
}

function readTurnState(source: Partial<TurnState>): Partial<TurnState> {
	const state: Partial<TurnState> = {};
	if (hasOwn(source, "activeTurn")) state.activeTurn = source.activeTurn;
	if (hasOwn(source, "activeTurnSequence"))
		state.activeTurnSequence = source.activeTurnSequence;
	if (hasOwn(source, "lastTurnIssue"))
		state.lastTurnIssue = source.lastTurnIssue;
	return state;
}

function isOlderSnapshot(
	incoming: { updatedAt?: unknown },
	existing: SessionRecord,
) {
	if (typeof incoming.updatedAt !== "string") return false;
	return Date.parse(incoming.updatedAt) < Date.parse(existing.updatedAt);
}

const HYDRATED_PROFILE_KEYS = ["userProfile", "participantProfiles"] as const;
type HydratedProfileKey = (typeof HYDRATED_PROFILE_KEYS)[number];

function settleHydratedProfile<K extends HydratedProfileKey>(
	result: SessionRecord,
	key: K,
	known: SessionRecord[K],
	received: SessionRecord[K],
	receivedIsCurrent: boolean,
) {
	const value =
		received !== undefined && (receivedIsCurrent || known === undefined)
			? received
			: known;
	if (value === undefined) delete result[key];
	else result[key] = value;
}

/**
 * Merge a possibly partial realtime session patch into a cached full session.
 *
 * Realtime session records intentionally omit hydrated profile fields. Treat
 * missing optional fields as "unknown / unchanged" rather than clearing local
 * cache, while still allowing explicit null / array values from list responses
 * to replace stale data.
 */
export function mergeSessionRecord(
	existing: SessionRecord | undefined | null,
	incoming: SessionRecordInput,
): SessionRecord {
	const received = readSessionStats(
		incoming.stats ? { stats: incoming.stats } : incoming.meta,
	);
	const previous = readSessionStats(existing?.meta);
	const stats =
		received && (!previous || received.revision >= previous.revision)
			? received
			: previous;
	const meta = hasOwn(incoming, "meta") ? incoming.meta : existing?.meta;
	const incomingIsOlder = Boolean(
		existing && isOlderSnapshot(incoming, existing),
	);
	const turnState = acceptsTurnState(existing, incoming)
		? readTurnState(incoming)
		: existing
			? readTurnState(existing)
			: {};
	const result: SessionRecord & { stats?: unknown } =
		existing && incomingIsOlder
			? {
					...existing,
					meta: stats ? { ...existing.meta, stats } : existing.meta,
					...turnState,
				}
			: {
					...existing,
					...incoming,
					meta: stats ? { ...meta, stats } : (meta ?? null),
					...turnState,
				};
	for (const key of HYDRATED_PROFILE_KEYS) {
		settleHydratedProfile(
			result,
			key,
			existing?.[key],
			incoming[key],
			!incomingIsOlder,
		);
	}
	// The wire-only field must not survive in canonical/cache records: they can
	// pass through another merge before being stored or applied to the workspace.
	result.meta = sanitizeSessionStatsMeta(result.meta);
	delete result.stats;
	return result;
}

export function mergeSessionRecords(
	sessions: SessionRecord[],
): SessionRecord[] {
	const byId = new Map<string, SessionRecord>();
	for (const session of sessions) {
		byId.set(session.id, mergeSessionRecord(byId.get(session.id), session));
	}
	return Array.from(byId.values());
}
