export type { BoardAutomationActivity, BoardPresenceChange } from "./activity.js";
export { boardAwarenessViewport } from "./gesture.js";
export * from "./presence.js";

const PEER_COLORS = ["blue", "green", "amber", "violet", "rose"] as const;

export function boardPeerColor(actorId: string): (typeof PEER_COLORS)[number] {
	let hash = 0x811c9dc5;
	for (let index = 0; index < actorId.length; index += 1) hash = Math.imul(hash ^ actorId.charCodeAt(index), 0x01000193);
	return PEER_COLORS[(hash >>> 0) % PEER_COLORS.length] as (typeof PEER_COLORS)[number];
}
