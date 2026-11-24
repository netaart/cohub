
import type { BoardAnimationHeader, BoardDocument, BoardItem, BoardScript } from "@cohub/protocol/board-model";
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
import { type BoardMediaCue, boardMediaCues } from "../model/timeline.js";
import { playbackClockAt } from "./playback-clock.js";

export * from "./playback-clock.js";
export * from "./transport.js";

const ENTER_ANIMATION = "\u0000enter";
const ENTER_STAGGER_MS = 45;
const ENTER_MAX_ITEMS = 80;
const AHEAD_MS = 3000;
const AHEAD_STEP_MS = 250;
const AHEAD_AUDIO = 3;

export type BoardPlayerFrame = {
	items: ReadonlyMap<string, BoardItem>;
	scripts: ReadonlyMap<string, BoardScript>;
	camera: BoardCameraOverride;
	cameraViewport: BoardAnimationHeader["viewport"];
	time: number;
	playbackTime: number | null;
	running: boolean;
};

export function createBoardPlayer(options: { resolveColor?: BoardColorResolver } = {}) {
	let document: BoardDocument | null = null;
	let compiled: CompiledBoardAnimations | null = null;
	let openedAt: number | null = performance.now();
	let entrance: { ids: string[]; startedAt: number; duration: number } | null = null;
	let cued: { document: BoardDocument; animationId: string; cues: BoardMediaCue[] } | null = null;

	function compile(next: BoardDocument) {
		if (document?.animations === next.animations && document?.items === next.items && document?.board.scripts === next.board.scripts && compiled) return compiled;
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
		hold() {
			openedAt = null;
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
					const time = boardAnimationTime(header, openedAt === null ? 0 : now - openedAt);
					if (time !== null) times.set(id, time);
					if (time !== null && time < header.duration && openedAt !== null) running = true;
				}
			}
			let playbackTime: number | null = null;
			if (playback && playback.animationId !== exclude) {
				const clock = playbackClockAt(playback, current, wallNow);
				playbackTime = clock.time;
				if (playbackTime !== null) times.set(playback.animationId, playbackTime);
				if (clock.advancing) running = true;
			}
			if (entrance) {
				times.set(ENTER_ANIMATION, now - entrance.startedAt);
				running = true;
			}
			const evaluation = times.size ? evaluateBoardAnimations(animations, times, options) : null;
			return {
				items: evaluation?.items ?? new Map(),
				scripts: evaluation?.scripts ?? new Map(),
				camera: evaluation?.camera ?? {},
				cameraViewport: evaluation?.cameraViewport,
				time: playbackTime ?? (openedAt === null ? 0 : now - openedAt),
				playbackTime,
				running,
			};
		},
		ahead(current: BoardDocument, playback: BoardPlaybackSnapshot | null, wallNow: number): BoardPlayerFrame[] {
			if (!playback) return [];
			const animations = compile(current);
			const header = animations.animations.get(playback.animationId)?.header;
			const start = header && playbackClockAt(playback, current, wallNow).time;
			if (!header || start == null) return [];
			const frames: BoardPlayerFrame[] = [];
			for (let time = start + AHEAD_STEP_MS; time <= Math.min(start + AHEAD_MS, header.duration); time += AHEAD_STEP_MS) {
				const evaluation = evaluateBoardAnimations(animations, new Map([[playback.animationId, time]]), options);
				frames.push({ ...evaluation, time, playbackTime: time, running: true });
			}
			return frames;
		},
		cues(current: BoardDocument, playback: BoardPlaybackSnapshot | null, wallNow: number, video: boolean): BoardMediaCue[] {
			const time = playback && playbackClockAt(playback, current, wallNow).time;
			if (!playback || time == null) return [];
			if (cued?.document.animations !== current.animations || cued.document.items !== current.items || cued.animationId !== playback.animationId)
				cued = { document: current, animationId: playback.animationId, cues: boardMediaCues(current, playback.animationId) };
			const result = new Map<string, BoardMediaCue>();
			let sounds = 0;
			for (const cue of cued.cues) {
				if (cue.end <= time || result.has(cue.id)) continue;
				if (cue.kind === "audio" ? sounds++ < AHEAD_AUDIO : video && cue.at - time <= AHEAD_MS) result.set(cue.id, cue);
			}
			return [...result.values()];
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
	const position = current ? (playbackClockAt(current, document, now).time ?? 0) : 0;
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
				effectiveAt: now + (command.preroll ?? 0),
			};
		case "pause":
			return current ? { ...current, ...base, status: "paused", position } : null;
		case "resume":
			if (!current || (command.ifCommand && command.ifCommand !== current.commandId)) return current;
			return { ...current, ...base, status: "playing", position };
		case "seek":
			return current ? { ...current, ...base, position: command.position, effectiveAt: now + (command.preroll ?? 0) } : null;
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
