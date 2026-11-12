import { parseRealtimeRoom, type RealtimeEnvelope, type RealtimeRoom, type RealtimeRoomRejection } from "@cohub/protocol/realtime";

export const ANONYMOUS_MAX_ROOMS = 8;
export const ANONYMOUS_IDLE_MS = 30_000;
export const ANONYMOUS_REAUTHORIZE_MS = 60_000;

export function anonymousRoomRequest(rooms: readonly RealtimeRoom[], following: ReadonlySet<RealtimeRoom>) {
	const boards: RealtimeRoom[] = [];
	const rejected: RealtimeRoomRejection[] = [];
	let followed = following.size;
	for (const room of rooms) {
		if (parseRealtimeRoom(room)?.kind !== "board") {
			rejected.push({ room, code: "FORBIDDEN", message: "Sign in to follow this room" });
		} else if (!following.has(room) && followed >= ANONYMOUS_MAX_ROOMS) {
			rejected.push({ room, code: "FORBIDDEN", message: "Too many Boards followed at once" });
		} else {
			if (!following.has(room)) followed += 1;
			boards.push(room);
		}
	}
	return { boards, rejected };
}

export function anonymousEnvelope(envelope: RealtimeEnvelope): RealtimeEnvelope | null {
	if (envelope.type === "board.playback.changed") return envelope;
	if (envelope.type !== "board.changed") return null;
	const { actorId: _actorId, actor: _actor, source: _source, ...payload } = envelope.payload as Record<string, unknown>;
	return { ...envelope, payload };
}
