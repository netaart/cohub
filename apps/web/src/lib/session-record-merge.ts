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
		return (
			hasOwn(incoming, "activeTurn") &&
			incoming.activeTurn === null &&
			existing?.activeTurnSequence === undefined
		);
	}
	const existingTurnAt = existing?.activeTurn?.updatedAt;
	const incomingTurnAt = incoming.activeTurn?.updatedAt;
	if (
		existingTurnAt &&
		incomingTurnAt &&
		Date.parse(incomingTurnAt) < Date.parse(existingTurnAt)
	)
		return false;
	const existingUpdatedAt = existing?.updatedAt;
	const incomingUpdatedAt = (incoming as { updatedAt?: unknown }).updatedAt;
	if (
		typeof existingUpdatedAt === "string" &&
		typeof incomingUpdatedAt === "string" &&
		Date.parse(incomingUpdatedAt) < Date.parse(existingUpdatedAt)
	)
		return false;
	return true;
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
	const activeTurnAccepted = shouldApplyActiveTurn(existing, incoming);
	const incomingIsOlder = Boolean(
		existing && isOlderSnapshot(incoming, existing),
	);
	const result: SessionRecord & { stats?: unknown } =
		existing && incomingIsOlder
			? {
					...existing,
					meta: stats ? { ...existing.meta, stats } : existing.meta,
					...(hasOwn(incoming, "activeTurn") && activeTurnAccepted
						? {
								activeTurn: incoming.activeTurn,
								activeTurnSequence: incoming.activeTurnSequence,
								...(hasOwn(incoming, "lastTurnIssue")
									? { lastTurnIssue: incoming.lastTurnIssue }
									: {}),
							}
						: {}),
				}
			: {
					...existing,
					...incoming,
					meta: stats ? { ...meta, stats } : (meta ?? null),
					participantUserUuids: hasOwn(incoming, "participantUserUuids")
						? incoming.participantUserUuids
						: existing?.participantUserUuids,
					...(hasOwn(incoming, "activeTurn") && !activeTurnAccepted
						? {
								activeTurn: existing?.activeTurn,
								activeTurnSequence: existing?.activeTurnSequence,
								lastTurnIssue: existing?.lastTurnIssue,
							}
						: {}),
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
