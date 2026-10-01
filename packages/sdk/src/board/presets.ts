
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
