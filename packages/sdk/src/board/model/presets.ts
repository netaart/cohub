
import type { BoardKeyframe, BoardTrack } from "@cohub/protocol";

type PresetTrack = { property: string; keyframes: Array<[at: number, value: unknown]>; ease?: string; composite?: "replace" | "add" };
type PresetDefinition = {
	description: string;
	duration: number;
	ease: string;
	tracks: PresetTrack[];
};

const OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const IN_OUT = "ease-in-out";

const PRESETS = {
	"fade-in": { description: "Fade in.", duration: 400, ease: "ease-out", tracks: [{ property: "opacity", keyframes: [[0, 0], [1, 1]] }] },
	"fade-out": { description: "Fade out.", duration: 400, ease: "ease-in", tracks: [{ property: "opacity", keyframes: [[0, 1], [1, 0]] }] },
	rise: {
		description: "Fade in while rising into place.",
		duration: 600,
		ease: OUT,
		tracks: [{ property: "position.y", keyframes: [[0, 40], [1, 0]] }, { property: "opacity", keyframes: [[0, 0], [1, 1]] }],
	},
	drop: {
		description: "Fade in while dropping into place.",
		duration: 600,
		ease: OUT,
		tracks: [{ property: "position.y", keyframes: [[0, -40], [1, 0]] }, { property: "opacity", keyframes: [[0, 0], [1, 1]] }],
	},
	pop: {
		description: "Scale up with a slight overshoot.",
		duration: 500,
		ease: OUT,
		tracks: [{ property: "scale", keyframes: [[0, 0.6], [0.7, 1.06], [1, 1]] }, { property: "opacity", keyframes: [[0, 0], [0.4, 1]] }],
	},
	deal: {
		description: "Slide in like a dealt card.",
		duration: 700,
		ease: OUT,
		tracks: [
			{ property: "position", keyframes: [[0, { x: -80, y: 40 }], [1, { x: 0, y: 0 }]] },
			{ property: "rotation", keyframes: [[0, -10], [1, 0]] },
			{ property: "opacity", keyframes: [[0, 0], [0.3, 1]] },
		],
	},
	draw: {
		description: "Draw the stroke from start to end.",
		duration: 1000,
		ease: IN_OUT,
		tracks: [{ property: "style.trim", keyframes: [[0, 0], [1, 1]], composite: "replace" }],
	},
	type: {
		description: "Type the text out character by character.",
		duration: 1200,
		ease: "linear",
		tracks: [{ property: "props.reveal", keyframes: [[0, 0], [1, 1]], composite: "replace" }],
	},
	pulse: {
		description: "Swell and settle once.",
		duration: 600,
		ease: IN_OUT,
		tracks: [{ property: "scale", keyframes: [[0, 1], [0.5, 1.08], [1, 1]] }],
	},
	float: {
		description: "Bob up and down; loop the animation for an idle drift.",
		duration: 2400,
		ease: IN_OUT,
		tracks: [{ property: "position.y", keyframes: [[0, 0], [0.5, -10], [1, 0]] }],
	},
	shake: {
		description: "Shake side to side.",
		duration: 500,
		ease: "linear",
		tracks: [{ property: "position.x", keyframes: [[0, 0], [0.15, -10], [0.3, 10], [0.45, -7], [0.6, 7], [0.8, -3], [1, 0]] }],
	},
	spin: {
		description: "Turn one full revolution.",
		duration: 1200,
		ease: "linear",
		tracks: [{ property: "rotation", keyframes: [[0, 0], [1, 360]] }],
	},
	flip: {
		description: "Turn over about the vertical axis, rising as it turns; shows depth.back. Flip again to turn back.",
		duration: 900,
		ease: IN_OUT,
		tracks: [
			{ property: "depth.tilt", keyframes: [[0, { x: 0, y: 0 }], [1, { x: 0, y: 180 }]] },
			{ property: "depth.lift", keyframes: [[0, 0], [0.5, 60], [1, 0]] },
		],
	},
	lift: {
		description: "Rise off the Board, leaning slightly, and stay up; land brings it back.",
		duration: 500,
		ease: OUT,
		tracks: [
			{ property: "depth.lift", keyframes: [[0, 0], [1, 60]] },
			{ property: "depth.tilt", keyframes: [[0, { x: 0, y: 0 }], [1, { x: 6, y: -4 }]] },
		],
	},
	land: {
		description: "Settle back onto the Board after lift.",
		duration: 450,
		ease: "cubic-bezier(0.5, 0, 0.75, 0)",
		tracks: [
			{ property: "depth.lift", keyframes: [[0, 0], [1, -60]] },
			{ property: "depth.tilt", keyframes: [[0, { x: 0, y: 0 }], [1, { x: -6, y: 4 }]] },
		],
	},
	toss: {
		description: "Toss up spinning like a handkerchief and drop back; size the height with --duration.",
		duration: 2400,
		ease: IN_OUT,
		tracks: [
			{ property: "depth.lift", keyframes: [[0, 0], [0.5, 280], [1, 0]] },
			{ property: "depth.spin", keyframes: [[0, 0], [1, 1080]], ease: "cubic-bezier(0.2, 0.6, 0.35, 1)" },
			{ property: "depth.tilt", keyframes: [[0, { x: 0, y: 0 }], [0.5, { x: 24, y: 10 }], [1, { x: 0, y: 0 }]] },
			{ property: "depth.bend.kind", keyframes: [[0, "cloth"]] },
			{ property: "depth.bend.amount", keyframes: [[0, 0], [0.5, 0.4], [1, 0]] },
			{ property: "depth.bend.phase", keyframes: [[0, 0], [1, 30]], ease: "linear" },
		],
	},
	sway: {
		description: "Lean back and forth like a card in hand; loop it for an idle sway.",
		duration: 3200,
		ease: IN_OUT,
		tracks: [{ property: "depth.tilt", keyframes: [[0, { x: 0, y: 0 }], [0.25, { x: 10, y: -14 }], [0.75, { x: -8, y: 12 }], [1, { x: 0, y: 0 }]] }],
	},
	wave: {
		description: "Ripple like a flag held at its left edge; loop it.",
		duration: 1600,
		ease: "linear",
		tracks: [
			{ property: "depth.bend.kind", keyframes: [[0, "wave"]] },
			{ property: "depth.bend.amount", keyframes: [[0, 0.8]] },
			{ property: "depth.bend.phase", keyframes: [[0, 0], [1, 2 * Math.PI]] },
		],
	},
	curl: {
		description: "Turn away like a page from its right edge.",
		duration: 1200,
		ease: IN_OUT,
		tracks: [
			{ property: "depth.bend.kind", keyframes: [[0, "curl"]] },
			{ property: "depth.bend.amount", keyframes: [[0, 0], [1, 1]] },
		],
	},
} satisfies Record<string, PresetDefinition>;

export type BoardPresetName = keyof typeof PRESETS;
export const BOARD_PRESET_NAMES = Object.keys(PRESETS) as BoardPresetName[];

export function isBoardPresetName(value: string): value is BoardPresetName {
	return Object.hasOwn(PRESETS, value);
}

export function listBoardPresets(): Array<{ name: BoardPresetName; description: string; duration: number; properties: string[] }> {
	return BOARD_PRESET_NAMES.map((name) => {
		const preset: PresetDefinition = PRESETS[name];
		return { name, description: preset.description, duration: preset.duration, properties: preset.tracks.map((track) => track.property) };
	});
}

export type BoardPresetOptions = {
	targets: readonly string[];
	at?: number;
	stagger?: number;
	duration?: number;
	ease?: string;
};

export type BoardNestedAnimationOptions = {
	parent: string;
	child: string;
	at?: number;
	duration: number;
	offset?: number;
	timeScale?: number;
};

export function boardNestedAnimationTrack(options: BoardNestedAnimationOptions): BoardTrack {
	const at = Math.max(0, options.at ?? 0);
	const timeScale = options.timeScale ?? 1;
	if (!Number.isFinite(timeScale) || timeScale <= 0) throw new RangeError("timeScale must be positive");
	const duration = options.duration ?? 0;
	if (!Number.isFinite(duration) || duration <= 0) throw new RangeError("duration must be positive");
	const offset = options.offset ?? 0;
	return {
		target: options.child,
		property: "time",
		keyframes: [
			{ at, value: offset },
			{ at: at + duration, value: offset + duration * timeScale },
		],
		composite: "replace",
		interpolation: "auto",
	};
}

export function boardNestedAnimation(
	options: BoardNestedAnimationOptions,
): Record<string, BoardTrack> {
	return { [`${options.parent}-play-${options.child}`]: boardNestedAnimationTrack(options) };
}



export function boardPresetTracks(name: BoardPresetName, options: BoardPresetOptions): Record<string, BoardTrack> {
	const preset: PresetDefinition = PRESETS[name];
	const duration = options.duration ?? preset.duration;
	const ease = options.ease ?? preset.ease;
	const tracks: Record<string, BoardTrack> = {};
	options.targets.forEach((target, index) => {
		const start = Math.max(0, (options.at ?? 0) + index * (options.stagger ?? 0));
		for (const track of preset.tracks) {
			const keyframes: BoardKeyframe[] = track.keyframes.map(([fraction, value], position) => ({
				at: Math.round(start + fraction * duration),
				value,
				...(position > 0 ? { ease: track.ease ?? ease } : {}),
			}));
			const suffix = track.property.split(".").at(-1) as string;
			tracks[`${target}-${name}-${suffix}`] = {
				target,
				property: track.property,
				keyframes,
				composite: track.composite ?? "add",
				interpolation: "auto",
			};
		}
	});
	return tracks;
}
