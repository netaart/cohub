
import type { BoardDocument, BoardItem } from "@cohub/protocol/board-model";
import type { BoardPlaybackCommand, BoardPlaybackSnapshot } from "@cohub/protocol";
import type {
	BoardCameraOverride,
	BoardColorResolver,
	CompiledBoardAnimations,
} from "../model/animation.js";
import {
	boardAnimationTime,
	compileBoardAnimations,
	evaluateBoardAnimations,
} from "../model/animation.js";
import { createBoardEntityId } from "../model/items/id.js";
import { boardPresetTracks, isBoardPresetName } from "../model/presets.js";

const ENTER_ANIMATION = "\u0000enter";
const ENTER_STAGGER_MS = 45;
const ENTER_MAX_ITEMS = 80;

export type BoardPlayerFrame = {
	items: ReadonlyMap<string, BoardItem>;
	camera: BoardCameraOverride;
	time: number;
	playbackTime: number | null;
	running: boolean;
};

export function playbackTimeAt(playback: BoardPlaybackSnapshot, document: BoardDocument, now: number): number | null {
	const animation = document.animations[playback.animationId];
	if (!animation || playback.status === "stopped") return null;
	if (playback.status !== "playing") return Math.min(playback.position, animation.duration);
	let position = playback.position + Math.max(0, now - playback.effectiveAt) * playback.timeScale;
	const pause = animation.markers.find((marker) => marker.pause && marker.at > playback.position && marker.at <= position);
	if (pause) return pause.at;
	if (animation.loop || animation.play === "always") return animation.duration > 0 ? position % animation.duration : 0;
	position = Math.min(position, animation.duration);
	return animation.end === "reset" && position >= animation.duration ? null : position;
}

export function createBoardPlayer(options: { resolveColor?: BoardColorResolver } = {}) {
	let document: BoardDocument | null = null;
	let compiled: CompiledBoardAnimations | null = null;
	let openedAt = performance.now();
	let entrance: { ids: string[]; startedAt: number; duration: number } | null = null;

	function compile(next: BoardDocument) {
		if (document?.animations === next.animations && document?.items === next.items && compiled) return compiled;
		document = next;
		let source = next;
		const preset = next.board.enter?.preset;
		if (entrance && preset && isBoardPresetName(preset)) {
			const tracks = boardPresetTracks(preset, {
				targets: entrance.ids,
				stagger: ENTER_STAGGER_MS,
				...(next.board.enter?.duration ? { duration: next.board.enter.duration } : {}),
			});
			source = {
				...next,
				animations: {
					...next.animations,
					[ENTER_ANIMATION]: { duration: entrance.duration, play: "manual", delay: 0, loop: false, end: "reset", markers: [], tracks },
				},
			};
		}
		compiled = compileBoardAnimations(source);
		return compiled;
	}

	return {
		reset() {
			openedAt = performance.now();
			entrance = null;
			compiled = null;
		},
		enter(ids: readonly string[], current: BoardDocument) {
			const preset = current.board.enter?.preset;
			if (!preset || ids.length === 0 || ids.length > ENTER_MAX_ITEMS) return;
			const duration = (current.board.enter?.duration ?? 700) + ENTER_STAGGER_MS * ids.length;
			entrance = { ids: [...ids], startedAt: performance.now(), duration };
			compiled = null;
		},
		frame(current: BoardDocument, playback: BoardPlaybackSnapshot | null, now: number, wallNow: number, exclude: string | null): BoardPlayerFrame {
			if (entrance && now - entrance.startedAt > entrance.duration) {
				entrance = null;
				compiled = null;
			}
			const animations = compile(current);
			const times = new Map<string, number>();
			let running = false;
			for (const [id, animation] of animations.animations) {
				if (id === exclude) continue;
				const header = animation.header;
				if (header.play === "always") {
					times.set(id, boardAnimationTime(header, wallNow) ?? 0);
					running = true;
				} else if (header.play === "auto") {
					const time = boardAnimationTime(header, now - openedAt);
					if (time !== null) times.set(id, time);
					if (time !== null && time < header.duration) running = true;
				}
			}
			let playbackTime: number | null = null;
			if (playback && playback.animationId !== exclude) {
				playbackTime = playbackTimeAt(playback, current, wallNow);
				if (playbackTime !== null) {
					times.set(playback.animationId, playbackTime);
					if (playback.status === "playing") running = true;
				}
			}
			if (entrance) {
				times.set(ENTER_ANIMATION, now - entrance.startedAt);
				running = true;
			}
			const evaluation = times.size ? evaluateBoardAnimations(animations, times, options) : null;
			return {
				items: evaluation?.items ?? new Map(),
				camera: evaluation?.camera ?? {},
				time: playbackTime ?? now - openedAt,
				playbackTime,
				running,
			};
		},
	};
}

export type BoardPlayer = ReturnType<typeof createBoardPlayer>;

export function nextLocalPlayback(
	current: BoardPlaybackSnapshot | null,
	command: BoardPlaybackCommand,
	document: BoardDocument,
	now = Date.now(),
): BoardPlaybackSnapshot | null {
	const position = current ? (playbackTimeAt(current, document, now) ?? 0) : 0;
	const base = { effectiveAt: now, commandId: command.commandId, revision: (current?.revision ?? 0) + 1 };
	switch (command.type) {
		case "play":
			return {
				playbackId: createBoardEntityId(),
				animationId: command.animationId,
				animationRevision: 0,
				status: "playing",
				position: command.position ?? 0,
				timeScale: command.timeScale ?? 1,
				seed: command.seed ?? "local",
				...base,
			};
		case "pause":
			return current ? { ...current, ...base, status: "paused", position } : null;
		case "resume":
			return current ? { ...current, ...base, status: "playing", position } : null;
		case "seek":
			return current ? { ...current, ...base, position: command.position } : null;
		case "next": {
			if (!current) return null;
			const markers = document.animations[current.animationId]?.markers ?? [];
			const after = markers.find((marker) => marker.pause && marker.at > position + 1);
			return { ...current, ...base, status: "playing", position: after ? position + 1 : position };
		}
		case "stop":
			return null;
	}
}
