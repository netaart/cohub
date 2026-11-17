import type { AnimationPlayer, AnimationState } from "@pixi/3d";
import type { BoardModelPlayback } from "../../model/model-clips.js";

export type ModelPlayback = {
	pose(playback: BoardModelPlayback, now: number): boolean;
};

type Clip = { label: string; state: AnimationState; duration: number };
type Layer = { clip: Clip; since: number; at: (now: number) => number };

const END = 1e-4;

function sample(clip: Clip, ms: number, loop: boolean): number {
	const seconds = Math.max(0, ms) / 1000;
	if (loop) return clip.duration > 0 ? seconds % clip.duration : 0;
	return Math.min(seconds, Math.max(0, clip.duration - END));
}

export function createModelPlayback(player: AnimationPlayer): ModelPlayback {
	const clips = new Map<string, Clip>();
	const clipOf = (label: string | null): Clip | null => {
		const name = label && player.getAnimation(label) ? label : player.animationLabels[0];
		if (!name) return null;
		let clip = clips.get(name);
		if (!clip) {
			const state = player.getState(name);
			state.loop = true;
			clip = { label: name, state, duration: state.animation.duration };
			clips.set(name, clip);
		}
		return clip;
	};
	let current: (Layer & { playback: BoardModelPlayback }) | null = null;
	let previous: (Layer & { from: number; fade: number }) | null = null;
	let applied = "";

	const layer = (clip: Clip, playback: BoardModelPlayback, since: number): Layer => ({
		clip,
		since,
		at: playback.time !== null ? () => sample(clip, playback.time as number, playback.loop) : playback.running ? (now) => sample(clip, now - since, playback.loop) : () => 0,
	});

	return {
		pose(playback, now) {
			const clip = clipOf(playback.clip);
			if (!clip) return false;
			if (!current) current = { ...layer(clip, playback, 0), playback };
			else if (current.clip !== clip) {
				const held = current.at(now);
				const leaving = current.playback.running ? current.at : () => held;
				previous = playback.fade > 0 ? { clip: current.clip, since: current.since, at: leaving, from: now, fade: playback.fade } : null;
				current = { ...layer(clip, playback, now), playback };
			} else if (current.playback.time !== playback.time || current.playback.loop !== playback.loop || current.playback.running !== playback.running) {
				const since = !playback.running ? 0 : current.playback.running ? current.since : now - current.at(now) * 1000;
				current = { ...layer(clip, playback, since), playback };
			}
			const blend = previous ? Math.min(1, Math.max(0, (now - previous.from) / previous.fade)) : 1;
			if (blend >= 1) previous = null;
			const time = current.at(now);
			const before = previous ? previous.at(now) : 0;
			const key = `${current.clip.label}:${time}:${previous?.clip.label ?? ""}:${before}:${blend}`;
			if (key !== applied) {
				applied = key;
				for (const other of clips.values()) if (other !== current.clip && other !== previous?.clip) other.state.stop();
				if (previous) {
					previous.clip.state.time = before;
					previous.clip.state.weight = 1 - blend;
					previous.clip.state.play();
				}
				current.clip.state.time = time;
				current.clip.state.weight = blend;
				current.clip.state.play();
				player.update({ deltaMS: 0 } as Parameters<AnimationPlayer["update"]>[0]);
			}
			const ended = !playback.loop && now - current.since >= clip.duration * 1000;
			return previous !== null || (playback.running && !ended);
		},
	};
}
