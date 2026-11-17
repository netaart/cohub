import type { GenerationStreamEvent } from "@neta-art/cohub";
import { sdk } from "#lib/sdk.ts";

type GenerationHandler = {
	event: (event: GenerationStreamEvent) => void;
	error?: (error: unknown) => void;
};

type GenerationRoom = {
	listeners: Set<GenerationHandler>;
	cleanup: () => void;
};

/**
 * Process-wide refcounted generation streams.
 * Space + Sessions hosts watching the same session share one subscribeGeneration.
 */
const rooms = new Map<string, GenerationRoom>();

function roomKey(spaceId: string, sessionId: string) {
	return `${spaceId}:${sessionId}`;
}

export function subscribeGenerationChannel(
	spaceId: string,
	sessionId: string,
	handler: GenerationHandler,
): () => void {
	if (!spaceId || !sessionId) return () => undefined;
	const key = roomKey(spaceId, sessionId);
	let room = rooms.get(key);
	if (!room) {
		const listeners = new Set<GenerationHandler>();
		const cleanup = sdk
			.space(spaceId)
			.session(sessionId)
			.subscribeGeneration(
				{
					event: (event) => {
						for (const current of [...listeners]) {
							try {
								current.event(event);
							} catch (error) {
								console.error("[generation-channel] listener error:", error);
							}
						}
					},
					error: (error) => {
						for (const current of [...listeners]) {
							try {
								current.error?.(error);
							} catch (listenerError) {
								console.error(
									"[generation-channel] error listener failed:",
									listenerError,
								);
							}
						}
					},
				},
				{ recover: true },
			);
		room = { listeners, cleanup };
		rooms.set(key, room);
	}
	room.listeners.add(handler);
	return () => {
		const current = rooms.get(key);
		if (!current) return;
		current.listeners.delete(handler);
		if (current.listeners.size > 0) return;
		current.cleanup();
		rooms.delete(key);
	};
}
