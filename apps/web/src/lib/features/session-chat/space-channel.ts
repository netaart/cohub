import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import { sdk } from "#lib/sdk.ts";

type SpaceChannelListener = (event: ChannelEnvelope) => void;

type SpaceChannelRoom = {
	listeners: Set<SpaceChannelListener>;
	cleanup: () => void;
};

/**
 * Process-wide refcounted space realtime rooms.
 * Multiple hosts/panels in the same space share one sdk.space(id).subscribe.
 */
const rooms = new Map<string, SpaceChannelRoom>();

export function subscribeSpaceChannel(
	spaceId: string,
	listener: SpaceChannelListener,
): () => void {
	if (!spaceId) return () => undefined;

	let room = rooms.get(spaceId);
	if (!room) {
		const listeners = new Set<SpaceChannelListener>();
		const cleanup = sdk.space(spaceId).subscribe((event) => {
			const envelope = event as ChannelEnvelope;
			// Snapshot listeners so unsub mid-dispatch is safe.
			for (const current of [...listeners]) {
				try {
					current(envelope);
				} catch (error) {
					console.error("[space-channel] listener error:", error);
				}
			}
		});
		room = { listeners, cleanup };
		rooms.set(spaceId, room);
	}

	room.listeners.add(listener);
	return () => {
		const current = rooms.get(spaceId);
		if (!current) return;
		current.listeners.delete(listener);
		if (current.listeners.size > 0) return;
		current.cleanup();
		rooms.delete(spaceId);
	};
}
