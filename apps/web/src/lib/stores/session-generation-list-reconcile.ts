import type { SessionRecord } from "@neta-art/cohub";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
import { resetGeneration } from "$lib/stores/session-generation-controller";

export function reconcileGenerationStateFromSessionList(
	sessions: SessionRecord[],
	options?: { authoritative?: boolean; requestStartedAt?: number },
) {
	const authoritative = options?.authoritative === true;
	const requestStartedAt = options?.requestStartedAt ?? 0;
	for (const session of sessions) {
		// Older cached list records do not have activeTurn. They are useful for
		// first paint, but cannot authoritatively clear or restore generation.
		if (session.activeTurn === undefined) continue;
		const current = sessionGenerationStore.get(session.id);
		const activeTurn = session.activeTurn;
		if (activeTurn) {
			if (
				current?.turnId !== activeTurn.id &&
				current &&
				current.status !== "idle"
			) {
				resetGeneration(session.id);
			}
			sessionGenerationStore.resumePending(session.id, {
				spaceId: session.spaceId,
				turnId: activeTurn.id,
				anchorUserMessageId: activeTurn.anchorUserMessageId,
			});
			continue;
		}
		if (
			authoritative &&
			current?.status === "pending" &&
			(current.lastEventAt ?? 0) <= requestStartedAt
		) {
			resetGeneration(session.id);
		}
	}
}
