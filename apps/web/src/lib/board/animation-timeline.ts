import type {
	BoardAnimation,
	BoardItem,
	BoardKeyframe,
	BoardScript,
} from "@cohub/protocol";
import { BOARD_CAMERA_TARGET } from "@cohub/protocol";
import {
	type BoardValueKind,
	getMediaResourceTitle,
	listBoardProperties,
	resolveBoardProperty,
} from "@neta-art/cohub/board";
import type { BoardKeyRef } from "@neta-art/cohub/board/editor";

export type BoardTrackRow = {
	key: string;
	target: string;
	property: string;
	kind: BoardValueKind;
	keyable: boolean;
	trackId: string | null;
	keyframes: readonly BoardKeyframe[];
	layers: ReadonlyArray<{
		trackId: string;
		keyframes: readonly BoardKeyframe[];
	}>;
};

export type BoardTrackGroup = {
	target: string;
	kind: "camera" | "item" | "animation" | "script";
	label: string;
	itemType: string | null;
	rows: BoardTrackRow[];
	times: number[];
};

const SUGGESTED = ["position", "rotation", "scale", "opacity"];
const ORDER = [
	"position",
	"size.width",
	"size.height",
	"rotation",
	"scale",
	"origin",
	"opacity",
	"center",
	"zoom",
	"focus",
	"shake",
	"time",
];

function propertyRank(property: string) {
	const index = ORDER.indexOf(property);
	return index < 0 ? ORDER.length : index;
}

export function boardItemLabel(item: BoardItem, fallback: string): string {
	switch (item.type) {
		case "text":
			return item.props.text.split("\n")[0] || fallback;
		case "shape":
			return item.props.text.split("\n")[0] || item.props.geometry;
		case "arrow":
		case "frame":
			return item.props.label || item.type;
		case "image":
		case "video":
		case "audio":
		case "file":
			return (
				item.props.snapshot?.title ?? getMediaResourceTitle(item.props.src)
			);
		case "task":
			return item.props.snapshot.title;
		case "effect":
			return item.props.kind;
		case "custom":
			return item.script.src.split("/").pop() ?? item.type;
		default:
			return fallback;
	}
}

function propertyKind(targetType: string, property: string): BoardValueKind {
	const resolved = resolveBoardProperty(targetType, property);
	return resolved.ok ? resolved.spec.kind : "discrete";
}

export function boardTrackGroups(input: {
	items: Readonly<Record<string, BoardItem>>;
	animations: Readonly<Record<string, BoardAnimation>>;
	scripts?: Readonly<Record<string, BoardScript>>;
	animation: BoardAnimation;
	selection: readonly string[];
	order: (id: string) => number;
}): BoardTrackGroup[] {
	const { items, animations, animation } = input;
	const groups = new Map<string, BoardTrackGroup>();
	const group = (target: string): BoardTrackGroup | null => {
		const existing = groups.get(target);
		if (existing) return existing;
		const item = items[target];
		const nested = animations[target];
		const script = input.scripts?.[target];
		if (target !== BOARD_CAMERA_TARGET && !item && !nested && !script)
			return null;
		const created: BoardTrackGroup = {
			target,
			kind:
				target === BOARD_CAMERA_TARGET
					? "camera"
					: item
						? "item"
						: nested
							? "animation"
							: "script",
			label: item ? boardItemLabel(item, target) : (nested?.name ?? target),
			itemType: item?.type ?? null,
			rows: [],
			times: [],
		};
		groups.set(target, created);
		return created;
	};
	const row = (entry: BoardTrackGroup, property: string): BoardTrackRow => {
		const existing = entry.rows.find((row) => row.property === property);
		if (existing) return existing;
		const created: BoardTrackRow = {
			key: `${entry.target}\u0000${property}`,
			target: entry.target,
			property,
			kind: propertyKind(
				entry.kind === "item" ? (entry.itemType ?? "") : entry.kind,
				property,
			),
			keyable:
				entry.kind === "item" ||
				(entry.kind === "camera" &&
					(property === "center" || property === "zoom")),
			trackId: null,
			keyframes: [],
			layers: [],
		};
		entry.rows.push(created);
		return created;
	};

	for (const [trackId, track] of Object.entries(animation.tracks)) {
		const entry = group(track.target);
		if (!entry) continue;
		const target = row(entry, track.property);
		if (track.composite === "replace" && target.trackId === null) {
			target.trackId = trackId;
			target.keyframes = track.keyframes;
		} else
			target.layers = [
				...target.layers,
				{ trackId, keyframes: track.keyframes },
			];
	}
	for (const id of input.selection) {
		const item = items[id];
		const entry = item ? group(id) : null;
		if (!entry || !item) continue;
		const available = new Set(
			listBoardProperties(item.type).map((entry) => entry.property),
		);
		for (const property of SUGGESTED)
			if (available.has(property)) row(entry, property);
	}

	for (const entry of groups.values()) {
		entry.rows.sort(
			(a, b) =>
				propertyRank(a.property) - propertyRank(b.property) ||
				(a.property < b.property ? -1 : 1),
		);
		const times = new Set<number>();
		for (const row of entry.rows) {
			for (const keyframe of row.keyframes) times.add(keyframe.at);
			for (const layer of row.layers)
				for (const keyframe of layer.keyframes) times.add(keyframe.at);
		}
		entry.times = [...times].sort((a, b) => a - b);
	}
	const rank = (entry: BoardTrackGroup) =>
		entry.kind === "camera"
			? -3
			: entry.kind === "script"
				? -2
				: entry.kind === "animation"
					? -1
					: 0;
	return [...groups.values()].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			input.order(a.target) - input.order(b.target) ||
			(a.target < b.target ? -1 : 1),
	);
}

export function boardAnimationExtent(animation: BoardAnimation): number {
	let end = animation.duration;
	for (const track of Object.values(animation.tracks))
		end = Math.max(end, track.keyframes.at(-1)?.at ?? 0);
	for (const marker of animation.markers) end = Math.max(end, marker.at);
	return Math.max(1, end);
}

const KEY_SEPARATOR = "\u0000";

export function boardKeyId(ref: BoardKeyRef): string {
	return `${ref.trackId}${KEY_SEPARATOR}${ref.at}`;
}

export function parseBoardKeyId(id: string): BoardKeyRef {
	const index = id.lastIndexOf(KEY_SEPARATOR);
	return { trackId: id.slice(0, index), at: Number(id.slice(index + 1)) };
}

const TICK_STEPS = [
	10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000,
	60_000, 120_000, 300_000, 600_000,
];

export function boardRulerTicks(
	scale: number,
	extent: number,
	minGap = 64,
): { step: number; times: number[] } {
	const step =
		TICK_STEPS.find((candidate) => candidate * scale >= minGap) ??
		(TICK_STEPS.at(-1) as number);
	const times: number[] = [];
	for (let time = 0; time <= extent + step / 2; time += step) times.push(time);
	return { step, times };
}

export function formatBoardTime(ms: number, step = 10): string {
	const digits = step >= 1000 ? 0 : step >= 100 ? 1 : 2;
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(digits)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = (seconds - minutes * 60).toFixed(digits);
	return `${minutes}:${rest.padStart(digits ? 3 + digits : 2, "0")}`;
}

export function snapBoardTime(
	time: number,
	candidates: Iterable<number>,
	threshold: number,
): number {
	let best = time;
	let distance = threshold;
	for (const candidate of candidates) {
		const gap = Math.abs(candidate - time);
		if (gap <= distance) {
			best = candidate;
			distance = gap;
		}
	}
	return best;
}

export type BoardBezier = readonly [number, number, number, number];

export const BOARD_EASE_PRESETS: ReadonlyArray<{
	id: string;
	value: string;
	curve: BoardBezier | null;
}> = [
	{ id: "linear", value: "linear", curve: [0, 0, 1, 1] },
	{ id: "ease", value: "ease", curve: [0.25, 0.1, 0.25, 1] },
	{ id: "ease-in", value: "ease-in", curve: [0.42, 0, 1, 1] },
	{ id: "ease-out", value: "ease-out", curve: [0, 0, 0.58, 1] },
	{ id: "ease-in-out", value: "ease-in-out", curve: [0.42, 0, 0.58, 1] },
	{
		id: "smooth-out",
		value: "cubic-bezier(0.22, 1, 0.36, 1)",
		curve: [0.22, 1, 0.36, 1],
	},
	{
		id: "overshoot",
		value: "cubic-bezier(0.34, 1.56, 0.64, 1)",
		curve: [0.34, 1.56, 0.64, 1],
	},
	{ id: "step-end", value: "step-end", curve: null },
];

export function parseBoardBezier(ease: string | undefined): BoardBezier | null {
	const value = (ease ?? "linear").trim();
	const preset = BOARD_EASE_PRESETS.find((entry) => entry.value === value);
	if (preset) return preset.curve;
	const match =
		/^cubic-bezier\(\s*([^,()]+),\s*([^,()]+),\s*([^,()]+),\s*([^,()]+)\)$/.exec(
			value,
		);
	if (!match) return null;
	const numbers = match.slice(1).map(Number);
	return numbers.every(Number.isFinite)
		? (numbers as unknown as BoardBezier)
		: null;
}

export function formatBoardBezier(curve: BoardBezier): string {
	const preset = BOARD_EASE_PRESETS.find((entry) =>
		entry.curve?.every((value, index) => value === curve[index]),
	);
	if (preset) return preset.value;
	const round = (value: number) => Number(value.toFixed(3));
	return `cubic-bezier(${curve.map(round).join(", ")})`;
}

export type BoardTrackRowState = "none" | "animated" | "keyed";

export function boardRowState(
	row: BoardTrackRow,
	time: number,
): BoardTrackRowState {
	if (!row.trackId) return "none";
	const at = Math.round(time);
	return row.keyframes.some((keyframe) => keyframe.at === at)
		? "keyed"
		: "animated";
}

export type BoardDockSelection =
	| { type: "keys"; ids: ReadonlySet<string> }
	| { type: "segment"; key: BoardKeyRef }
	| { type: "marker"; at: number }
	| null;
