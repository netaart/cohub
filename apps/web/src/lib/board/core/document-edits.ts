import {
	type BoardAnimation,
	type BoardDocument,
	type BoardItem,
	type BoardPatch,
	type BoardTrack,
	diffMergePatch,
	listBoardProperties,
	scaleVector,
} from "@neta-art/cohub/board";

export function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
			return false;
		for (let index = 0; index < a.length; index += 1) {
			if (!sameJson(a[index], b[index])) return false;
		}
		return true;
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	let members = 0;
	for (const key of Object.keys(left)) {
		if (left[key] === undefined) continue;
		members += 1;
		if (!sameJson(left[key], right[key])) return false;
	}
	for (const key of Object.keys(right))
		if (right[key] !== undefined) members -= 1;
	return members === 0;
}

export function readPath(value: unknown, path: readonly string[]): unknown {
	let current = value;
	for (const segment of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

export function writePath<T>(
	value: T,
	path: readonly string[],
	next: unknown,
): T {
	const [head, ...rest] = path;
	if (head === undefined) return next as T;
	const record = (value && typeof value === "object" ? value : {}) as Record<
		string,
		unknown
	>;
	return { ...record, [head]: writePath(record[head], rest, next) } as T;
}

const KEYFRAMABLE_KINDS = new Set(["number", "vec2", "scale", "color"]);
const STRUCTURAL_KEYS = ["parent", "z", "locked", "metadata"] as const;

export type BoardEditPlayhead = { animationId: string; time: number };

function keyframe(
	animations: Record<string, BoardAnimation>,
	playhead: BoardEditPlayhead,
	recording: boolean,
	id: string,
	property: string,
	value: unknown,
	storedValue: unknown,
): boolean {
	const animation = animations[playhead.animationId];
	if (!animation) return false;
	const time = Math.round(playhead.time);
	const existing = Object.entries(animation.tracks).find(
		([, track]) =>
			track.target === id &&
			track.property === property &&
			track.composite === "replace",
	);
	if (!existing && !recording) return false;
	const candidateId = `${id}-${property.replaceAll(".", "-")}`;
	const newId =
		candidateId.length <= 160 && !Object.hasOwn(animation.tracks, candidateId)
			? candidateId
			: crypto.randomUUID();
	const [trackId, track]: [string, BoardTrack] = existing ?? [
		newId,
		{
			target: id,
			property,
			keyframes: time > 0 ? [{ at: 0, value: storedValue }] : [],
			composite: "replace",
			interpolation: "auto",
		},
	];
	const keyframes = [
		...track.keyframes.filter((entry) => entry.at !== time),
		{ at: time, value },
	].sort((a, b) => a.at - b.at);
	animations[playhead.animationId] = {
		...animation,
		duration: Math.max(animation.duration, time),
		tracks: { ...animation.tracks, [trackId]: { ...track, keyframes } },
	};
	return true;
}

function authoredValue(
	stored: unknown,
	shown: unknown,
	next: unknown,
	property = "",
): unknown {
	if (sameJson(shown, next)) return stored;
	if (
		property === "scale" &&
		stored !== undefined &&
		shown !== undefined &&
		next !== undefined &&
		[stored, shown, next].some((value) => typeof value === "object")
	) {
		return authoredValue(
			scaleVector(stored as BoardItem["scale"]),
			scaleVector(shown as BoardItem["scale"]),
			scaleVector(next as BoardItem["scale"]),
			"scale.vector",
		);
	}
	if (
		typeof stored === "number" &&
		typeof shown === "number" &&
		typeof next === "number"
	) {
		if (property === "opacity")
			return Math.max(0, Math.min(1, shown ? (stored * next) / shown : next));
		if (property === "scale" || property.startsWith("scale."))
			return shown ? (stored * next) / shown : next;
		return stored + next - shown;
	}
	const record = (value: unknown): value is Record<string, unknown> =>
		Boolean(value) && typeof value === "object" && !Array.isArray(value);
	if (record(stored) && record(shown) && record(next)) {
		const result = { ...stored };
		for (const key of new Set([...Object.keys(shown), ...Object.keys(next)])) {
			if (sameJson(shown[key], next[key])) continue;
			if (!(key in next)) delete result[key];
			else
				result[key] = authoredValue(
					stored[key],
					shown[key],
					next[key],
					property ? `${property}.${key}` : key,
				);
		}
		return result;
	}
	return next;
}

export function routeBoardEdits(input: {
	base: BoardDocument;
	evaluated: ReadonlyMap<string, BoardItem>;
	draft: ReadonlyMap<string, BoardItem | null>;
	displayed?: ReadonlyMap<string, BoardItem>;
	playhead: BoardEditPlayhead | null;
	recording: boolean;
}): BoardDocument {
	const { base, evaluated, draft, playhead, recording } = input;
	if (draft.size === 0) return base;
	const items = { ...base.items };
	const animations = { ...base.animations };
	let keyed = false;
	for (const [id, next] of draft) {
		const stored = base.items[id];
		if (!next) {
			delete items[id];
			continue;
		}
		const shown = input.displayed?.get(id) ?? evaluated.get(id) ?? stored;
		if (!stored || next.type !== stored.type) {
			items[id] = next;
			continue;
		}
		if (!playhead) {
			items[id] = authoredValue(stored, shown, next) as BoardItem;
			continue;
		}
		const properties = listBoardProperties(next.type);
		let item = stored;
		for (const { property, kind } of properties) {
			const path = property.split(".");
			const value = readPath(next, path);
			if (sameJson(value, readPath(shown, path))) continue;
			if (
				KEYFRAMABLE_KINDS.has(kind) &&
				keyframe(
					animations,
					playhead,
					recording,
					id,
					property,
					value,
					readPath(stored, path),
				)
			)
				keyed = true;
			else
				item = writePath(
					item,
					path,
					authoredValue(
						readPath(stored, path),
						readPath(shown, path),
						value,
						property,
					),
				);
		}
		for (const key of STRUCTURAL_KEYS) {
			if (!sameJson(next[key], shown[key])) {
				const copy = { ...item } as Record<string, unknown>;
				if (next[key] === undefined) delete copy[key];
				else copy[key] = next[key];
				item = copy as BoardItem;
			}
		}
		items[id] = item;
	}
	return { ...base, items, animations: keyed ? animations : base.animations };
}

export function isEmptyBoardPatch(patch: BoardPatch): boolean {
	return !patch.board && !patch.items && !patch.animations;
}

export function diffBoardEdits(
	from: BoardDocument,
	to: BoardDocument,
	ids: Iterable<string>,
): BoardPatch {
	const patch: BoardPatch = {};
	if (from.board !== to.board && !sameJson(from.board, to.board))
		patch.board = diffMergePatch(from.board, to.board) as Record<
			string,
			unknown
		>;
	const itemPatch: NonNullable<BoardPatch["items"]> = {};
	for (const id of new Set(ids)) {
		const before = from.items[id];
		const after = to.items[id];
		if (before === after) continue;
		if (!after) {
			if (before) itemPatch[id] = null;
		} else if (!before || before.type !== after.type)
			itemPatch[id] = after as Record<string, unknown>;
		else {
			const change = diffMergePatch(before, after);
			if (change && typeof change === "object" && Object.keys(change).length)
				itemPatch[id] = change as Record<string, unknown>;
		}
	}
	if (Object.keys(itemPatch).length) patch.items = itemPatch;
	if (from.animations !== to.animations) {
		const animationPatch: NonNullable<BoardPatch["animations"]> = {};
		for (const id of new Set([
			...Object.keys(from.animations),
			...Object.keys(to.animations),
		])) {
			const before = from.animations[id];
			const after = to.animations[id];
			if (before === after) continue;
			if (!after) animationPatch[id] = null;
			else {
				const change = diffMergePatch(before ?? {}, after);
				if (change && typeof change === "object" && Object.keys(change).length)
					animationPatch[id] = change as NonNullable<
						BoardPatch["animations"]
					>[string];
			}
		}
		if (Object.keys(animationPatch).length) patch.animations = animationPatch;
	}
	return patch;
}
