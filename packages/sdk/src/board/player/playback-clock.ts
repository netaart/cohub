import type { BoardPlaybackSnapshot } from "@cohub/protocol";
import type { BoardDocument } from "@cohub/protocol/board-model";

export type BoardPlaybackClock = { time: number | null; advancing: boolean };

const SETTLED: BoardPlaybackClock = { time: null, advancing: false };

export function playbackClockAt(playback: BoardPlaybackSnapshot, document: BoardDocument, now: number): BoardPlaybackClock {
	const animation = document.animations[playback.animationId];
	if (!animation || playback.status === "stopped") return SETTLED;
	if (playback.status !== "playing") return { time: Math.min(playback.position, animation.duration), advancing: false };
	const position = playback.position + Math.max(0, now - playback.effectiveAt) * playback.timeScale;
	const pause = animation.markers.find((marker) => marker.pause && marker.at > playback.position && marker.at <= position);
	if (pause) return { time: pause.at, advancing: false };
	if (animation.loop || animation.play === "always") return { time: position % animation.duration, advancing: true };
	if (position < animation.duration) return { time: position, advancing: true };
	return { time: animation.end === "reset" ? null : animation.duration, advancing: false };
}
