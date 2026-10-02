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

function activeTurnRank(activeTurn: SessionRecord["activeTurn"] | undefined) {
	if (!activeTurn) return 3;
	if (activeTurn.status === "abort_requested") return 2;
	if (activeTurn.status === "running") return 1;
	return 0;
}

function shouldApplyActiveTurn(
	existing: SessionRecord | undefined | null,
	incoming: Omit<SessionRecord, "meta"> & {
		meta?: SessionRecord["meta"];
		stats?: unknown;
	},
) {
	if (
		!hasOwn(incoming, "activeTurn") ||
		!hasOwn(incoming, "activeTurnSequence")
	) {
		return hasOwn(incoming, "activeTurn") && incoming.activeTurn === null;
	}
	const currentSequence = existing?.activeTurnSequence;
	const incomingSequence = incoming.activeTurnSequence;
	if (currentSequence === undefined || incomingSequence === undefined)
		return true;
	if (incomingSequence !== currentSequence)
		return incomingSequence > currentSequence;
	return (
		activeTurnRank(incoming.activeTurn) >= activeTurnRank(existing?.activeTurn)
	);
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
	incoming: Omit<SessionRecord, "meta"> & {
		meta?: SessionRecord["meta"];
		stats?: unknown;
	},
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
	// A stats notification is not a fresh title/activity/profile snapshot.
	const activeTurnAccepted = shouldApplyActiveTurn(existing, incoming);
	const result: SessionRecord & { stats?: unknown } =
		hasOwn(incoming, "stats") && existing
			? {
					...existing,
					meta: stats ? { ...existing.meta, stats } : existing.meta,
				}
			: {
					...existing,
					...incoming,
					meta: stats ? { ...meta, stats } : (meta ?? null),
					userProfile: hasOwn(incoming, "userProfile")
						? incoming.userProfile
						: existing?.userProfile,
					participantUserUuids: hasOwn(incoming, "participantUserUuids")
						? incoming.participantUserUuids
						: existing?.participantUserUuids,
					participantProfiles: hasOwn(incoming, "participantProfiles")
						? incoming.participantProfiles
						: existing?.participantProfiles,
					...(hasOwn(incoming, "activeTurn") && !activeTurnAccepted
						? {
								activeTurn: existing?.activeTurn,
								activeTurnSequence: existing?.activeTurnSequence,
							}
						: {}),
				};
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
