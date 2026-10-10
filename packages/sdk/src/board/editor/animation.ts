import { type BoardTrack, createBoardItemId } from "../model/index.js";
import type { BoardPlayhead, EditorContext } from "./context.js";
import { readPath, sameJson } from "./document-edits.js";

export function createAnimationModule(ctx: EditorContext) {
	const { state, options } = ctx;

	function setPlayhead(next: BoardPlayhead | null) {
		if (next && !state.base.animations[next.animationId]) next = null;
		if (sameJson(next, state.playhead)) return;
		state.playhead = next;
		if (!next) state.recording = false;
		ctx.document.discardDraft();
	}

	function setRecording(value: boolean) {
		state.recording = value && state.playhead !== null && !options.readonly;
	}

	function current() {
		const { playhead, base } = state;
		const animation = playhead ? base.animations[playhead.animationId] : undefined;
		return playhead && animation ? { playhead, animation } : null;
	}

	function tracksFor(itemId: string): Map<string, [string, BoardTrack]> {
		const result = new Map<string, [string, BoardTrack]>();
		const animation = current()?.animation;
		if (!animation) return result;
		for (const [trackId, track] of Object.entries(animation.tracks))
			if (track.target === itemId) result.set(track.property, [trackId, track]);
		return result;
	}

	function keyframeState(property: string): "none" | "animated" | "keyframe" {
		const selected = ctx.selection.items();
		if (!state.playhead || selected.length === 0) return "none";
		const time = Math.round(state.playhead.time);
		let animated = true;
		let keyed = true;
		for (const item of selected) {
			const track = tracksFor(item.id).get(property)?.[1];
			if (!track) animated = false;
			if (!track?.keyframes.some((keyframe) => keyframe.at === time)) keyed = false;
		}
		return keyed ? "keyframe" : animated ? "animated" : "none";
	}

	function commitAnimation(animationId: string, animation: (typeof state.base.animations)[string]) {
		ctx.document.commit({ animations: { ...state.base.animations, [animationId]: animation } });
	}

	function toggleKeyframe(property: string) {
		const found = options.readonly ? null : current();
		if (!found) return;
		const { playhead, animation } = found;
		const time = Math.round(playhead.time);
		const tracks = { ...animation.tracks };
		const remove = keyframeState(property) === "keyframe";
		for (const item of ctx.selection.items()) {
			const existing = tracksFor(item.id).get(property);
			const shown = readPath(ctx.document.displayItem(item.id), property.split("."));
			if (remove && existing) {
				const keyframes = existing[1].keyframes.filter((keyframe) => keyframe.at !== time);
				if (keyframes.length) tracks[existing[0]] = { ...existing[1], keyframes };
				else delete tracks[existing[0]];
			} else if (!remove) {
				const [trackId, track]: [string, BoardTrack] = existing ?? [
					`${item.id}-${property.replaceAll(".", "-")}`,
					{ target: item.id, property, keyframes: [], composite: "replace", interpolation: "auto" },
				];
				const keyframes = [
					...track.keyframes.filter((keyframe) => keyframe.at !== time),
					{ at: time, value: shown },
				].sort((a, b) => a.at - b.at);
				tracks[trackId] = { ...track, keyframes };
			}
		}
		commitAnimation(playhead.animationId, { ...animation, duration: Math.max(animation.duration, time), tracks });
	}

	function trackAt(trackId: string) {
		const found = options.readonly ? null : current();
		const track = found?.animation.tracks[trackId];
		return found && track ? { ...found, track } : null;
	}

	function removeKeyframe(trackId: string, at: number) {
		const found = trackAt(trackId);
		if (!found) return;
		const { playhead, animation, track } = found;
		const time = Math.round(at);
		const keyframes = track.keyframes.filter((keyframe) => keyframe.at !== time);
		const tracks = { ...animation.tracks };
		if (keyframes.length) tracks[trackId] = { ...track, keyframes };
		else delete tracks[trackId];
		commitAnimation(playhead.animationId, { ...animation, tracks });
	}

	function setKeyframeEase(trackId: string, at: number, ease: string | null) {
		const found = trackAt(trackId);
		if (!found) return;
		const { playhead, animation, track } = found;
		const time = Math.round(at);
		const keyframes = track.keyframes.map((keyframe) => {
			if (keyframe.at !== time) return keyframe;
			if (!ease || ease === "linear") {
				const { ease: _removed, ...rest } = keyframe;
				return rest;
			}
			return { ...keyframe, ease };
		});
		commitAnimation(playhead.animationId, { ...animation, tracks: { ...animation.tracks, [trackId]: { ...track, keyframes } } });
	}

	function createAnimation(name: string, duration = 5000): string {
		const id = createBoardItemId();
		commitAnimation(id, { name, duration, play: "manual", delay: 0, loop: false, end: "hold", markers: [], tracks: {} });
		setPlayhead({ animationId: id, time: 0 });
		return id;
	}

	return { setPlayhead, setRecording, keyframeState, toggleKeyframe, removeKeyframe, setKeyframeEase, createAnimation };
}

export type AnimationModule = ReturnType<typeof createAnimationModule>;
