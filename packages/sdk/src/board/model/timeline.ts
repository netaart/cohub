import {
	BOARD_CAMERA_TARGET,
	type BoardAnimation,
	type BoardDocument,
	type BoardKeyframe,
	type BoardTrack,
} from "@cohub/protocol";
import { compileBoardTrack, sampleBoardTrack } from "./animation.js";
import { createBoardEntityId } from "./items/id.js";
import { sameJson } from "./json.js";

export type BoardSpan = { start: number; end: number };

export type BoardTimelinePlacement = {
	at: number;
	duration?: number;
	from?: number;
	rate?: number;
};

export const BOARD_SPAN_DEFAULT_MS = 3000;
export const BOARD_SPAN_MIN_MS = 40;
const VISIBLE = "visible";

export function newBoardTrackId(tracks: Readonly<Record<string, BoardTrack>>, target: string, property: string): string {
	const id = `${target}-${property.replaceAll(".", "-")}`;
	return id.length <= 160 && !Object.hasOwn(tracks, id) ? id : createBoardEntityId();
}

export function findBoardKeyTrack(
	tracks: Readonly<Record<string, BoardTrack>>,
	target: string,
	property: string,
): [string, BoardTrack] | undefined {
	return Object.entries(tracks).find(
		([, track]) => track.target === target && track.property === property && track.composite === "replace",
	);
}

function targetType(document: BoardDocument, target: string): string | null {
	if (target === BOARD_CAMERA_TARGET) return BOARD_CAMERA_TARGET;
	if (document.animations[target]) return "animation";
	if (document.board.scripts?.[target]) return "script";
	return document.items[target]?.type ?? null;
}

export function boardPlayProperty(document: BoardDocument, target: string): string | null {
	const type = targetType(document, target);
	return type === "video" || type === "audio" ? "props.time" : type === "animation" ? "time" : null;
}

export function boardPlayLength(document: BoardDocument, target: string): number | null {
	const item = document.items[target];
	if (item?.type === "video" || item?.type === "audio") return item.props.snapshot?.durationMs || null;
	return document.animations[target]?.duration ?? null;
}

function visibleSpan(track: BoardTrack, duration: number): BoardSpan | null {
	let start: number | null = null;
	let lastShown = -1;
	let end: number | null = null;
	for (const keyframe of track.keyframes) {
		if (keyframe.value !== false) {
			start ??= keyframe.at;
			lastShown = keyframe.at;
			end = null;
		} else if (start !== null && end === null) end = keyframe.at;
	}
	return start === null ? null : { start, end: end ?? Math.max(duration, lastShown) };
}

export function boardClipSpan(tracks: { visible?: BoardTrack; play?: BoardTrack }, duration: number): BoardSpan | null {
	if (tracks.visible) return visibleSpan(tracks.visible, duration);
	const first = tracks.play?.keyframes[0];
	const last = tracks.play?.keyframes.at(-1);
	return first && last && last.at > first.at ? { start: first.at, end: last.at } : null;
}

export function boardTargetSpan(document: BoardDocument, animation: BoardAnimation, target: string): BoardSpan | null {
	const property = boardPlayProperty(document, target);
	return boardClipSpan(
		{
			visible: findBoardKeyTrack(animation.tracks, target, VISIBLE)?.[1],
			play: property ? findBoardKeyTrack(animation.tracks, target, property)?.[1] : undefined,
		},
		animation.duration,
	);
}

function visibleKeyframes(start: number, end: number): BoardKeyframe[] {
	if (end <= start) return [{ at: 0, value: false }];
	return [...(start > 0 ? [{ at: 0, value: false }] : []), { at: start, value: true }, { at: end, value: false }];
}

function normalizeVisible(keyframes: readonly BoardKeyframe[]): BoardKeyframe[] {
	const sorted = keyframes.map((keyframe, index) => ({ keyframe, index })).sort((a, b) => a.keyframe.at - b.keyframe.at || a.index - b.index);
	const result: BoardKeyframe[] = [];
	for (const { keyframe } of sorted) {
		const previous = result.at(-1);
		if (previous?.at === keyframe.at) result.pop();
		if (result.at(-1)?.value === keyframe.value) continue;
		result.push(keyframe);
	}
	if (result[0]?.value !== false && (result[0]?.at ?? 0) > 0) result.unshift({ at: 0, value: false });
	return result;
}

function withDuration(animation: BoardAnimation, end: number): BoardAnimation {
	return end > animation.duration ? { ...animation, duration: Math.ceil(end) } : animation;
}

function setTrack(
	tracks: Record<string, BoardTrack>,
	target: string,
	property: string,
	keyframes: BoardKeyframe[],
	interpolation: BoardTrack["interpolation"] = "auto",
) {
	const existing = findBoardKeyTrack(tracks, target, property);
	const id = existing?.[0] ?? newBoardTrackId(tracks, target, property);
	tracks[id] = existing ? { ...existing[1], keyframes } : { target, property, keyframes, composite: "replace", interpolation };
}

function sampleTrack(document: BoardDocument, track: BoardTrack, time: number): unknown {
	const type = targetType(document, track.target);
	const compiled = type ? compileBoardTrack("", "", track, type) : null;
	if (compiled) return sampleBoardTrack(compiled, time);
	return [...track.keyframes].reverse().find((keyframe) => keyframe.at <= time)?.value ?? track.keyframes[0]?.value;
}

function slope(a: BoardKeyframe | undefined, b: BoardKeyframe | undefined): number {
	if (!a || !b || b.at <= a.at || typeof a.value !== "number" || typeof b.value !== "number") return 0;
	return (b.value - a.value) / (b.at - a.at);
}

function playValue(document: BoardDocument, track: BoardTrack, time: number): number {
	const { keyframes } = track;
	const first = keyframes[0] as BoardKeyframe;
	const last = keyframes.at(-1) as BoardKeyframe;
	if (time < first.at) return Math.max(0, (first.value as number) - slope(first, keyframes[1]) * (first.at - time));
	if (time > last.at) return Math.max(0, (last.value as number) + slope(keyframes.at(-2), last) * (time - last.at));
	const value = sampleTrack(document, track, time);
	return typeof value === "number" ? value : 0;
}

function shiftKeyframes(keyframes: readonly BoardKeyframe[], shift: number): BoardKeyframe[] {
	return keyframes.map((keyframe) => ({ ...keyframe, at: keyframe.at + shift }));
}

function withoutAnchor(track: BoardTrack): readonly BoardKeyframe[] {
	const [first, second] = track.keyframes;
	return track.property === VISIBLE && first?.at === 0 && first.value === false && second ? track.keyframes.slice(1) : track.keyframes;
}

export function boardPlaceTarget(document: BoardDocument, animation: BoardAnimation, target: string, placement: BoardTimelinePlacement): BoardAnimation {
	const at = Math.max(0, Math.round(placement.at));
	const existing = boardTargetSpan(document, animation, target);
	if (existing) return boardShiftTargets(document, animation, [target], at - existing.start);
	const rate = placement.rate && placement.rate > 0 ? placement.rate : 1;
	const from = Math.max(0, placement.from ?? 0);
	const length = boardPlayLength(document, target);
	const remaining = length !== null && length > from ? (length - from) / rate : null;
	const duration = Math.max(BOARD_SPAN_MIN_MS, Math.round(placement.duration ?? remaining ?? BOARD_SPAN_DEFAULT_MS));
	const tracks = { ...animation.tracks };
	if (document.items[target]) setTrack(tracks, target, VISIBLE, visibleKeyframes(at, at + duration), "step");
	const property = boardPlayProperty(document, target);
	if (property) setTrack(tracks, target, property, [{ at, value: from }, { at: at + duration, value: from + duration * rate }]);
	return withDuration({ ...animation, tracks }, at + duration);
}

export function boardShiftTargets(document: BoardDocument, animation: BoardAnimation, targets: readonly string[], delta: number): BoardAnimation {
	const owned = Object.entries(animation.tracks).filter(([, track]) => targets.includes(track.target));
	const spans = targets.map((target) => boardTargetSpan(document, animation, target));
	const keyed = Math.min(...owned.map(([, track]) => withoutAnchor(track)[0]?.at ?? Number.POSITIVE_INFINITY));
	const earliest = Math.min(...spans.map((span) => span?.start ?? keyed));
	if (!Number.isFinite(earliest)) return animation;
	const shift = Math.round(Math.max(delta, -earliest));
	if (shift === 0) return animation;
	const tracks = { ...animation.tracks };
	let end = Math.max(0, ...spans.map((span) => (span ? span.end + shift : 0)));
	for (const [id, track] of owned) {
		let body = withoutAnchor(track);
		if ((body[0]?.at ?? 0) < -shift) {
			const after = cutTrack(document, { ...track, keyframes: [...body] }, -shift).after;
			body = after.length ? after : [{ ...(body.at(-1) as BoardKeyframe), at: -shift }];
		}
		const moved = shiftKeyframes(body, shift);
		const keyframes = track.property === VISIBLE ? normalizeVisible(moved) : moved;
		tracks[id] = { ...track, keyframes };
		if (!spans.some(Boolean)) end = Math.max(end, keyframes.at(-1)?.at ?? 0);
	}
	return withDuration({ ...animation, tracks }, end);
}

export function boardTrimLimits(document: BoardDocument, animation: BoardAnimation, target: string): BoardSpan {
	const property = boardPlayProperty(document, target);
	const play = property ? findBoardKeyTrack(animation.tracks, target, property)?.[1] : undefined;
	const first = play?.keyframes[0];
	const last = play?.keyframes.at(-1);
	if (!play || !first || !last) return { start: 0, end: Number.POSITIVE_INFINITY };
	const head = slope(first, play.keyframes[1]);
	const tail = slope(play.keyframes.at(-2), last);
	const length = boardPlayLength(document, target);
	const start = head > 0 && typeof first.value === "number" ? first.at - first.value / head : 0;
	const end = tail > 0 && length !== null && typeof last.value === "number" ? last.at + (length - last.value) / tail : Number.POSITIVE_INFINITY;
	return { start: Math.max(0, Math.ceil(start)), end: Math.max(last.at, Math.floor(end)) };
}

export function boardTrimTarget(
	document: BoardDocument,
	animation: BoardAnimation,
	target: string,
	edge: "start" | "end",
	at: number,
): BoardAnimation {
	const span = boardTargetSpan(document, animation, target);
	if (!span) return animation;
	const limits = boardTrimLimits(document, animation, target);
	const time =
		edge === "start"
			? Math.round(Math.min(Math.max(at, limits.start), span.end - BOARD_SPAN_MIN_MS))
			: Math.round(Math.max(Math.min(at, limits.end), span.start + BOARD_SPAN_MIN_MS));
	if (time === span[edge]) return animation;
	const next = edge === "start" ? { start: time, end: span.end } : { start: span.start, end: time };
	const tracks = { ...animation.tracks };
	if (findBoardKeyTrack(tracks, target, VISIBLE)) setTrack(tracks, target, VISIBLE, visibleKeyframes(next.start, next.end), "step");
	const property = boardPlayProperty(document, target);
	const play = property ? findBoardKeyTrack(tracks, target, property) : undefined;
	if (play) {
		const [id, track] = play;
		const first = track.keyframes[0] as BoardKeyframe;
		const last = track.keyframes.at(-1) as BoardKeyframe;
		let keyframes: BoardKeyframe[];
		if (time > first.at && time < last.at) keyframes = cutTrack(document, track, time)[edge === "start" ? "after" : "before"];
		else {
			const cut = { at: time, value: playValue(document, track, time) };
			keyframes = edge === "start" ? [cut, ...track.keyframes.filter((keyframe) => keyframe.at > time)] : [...track.keyframes.filter((keyframe) => keyframe.at < time), cut];
		}
		tracks[id] = { ...track, keyframes };
	}
	return withDuration({ ...animation, tracks }, next.end);
}

function cutValue(document: BoardDocument, track: BoardTrack, at: number): BoardKeyframe {
	return { at, value: sampleTrack(document, track, at) as BoardKeyframe["value"] };
}

type Curve = readonly [number, number, number, number];
const CURVES: Record<string, Curve> = {
	ease: [0.25, 0.1, 0.25, 1],
	"ease-in": [0.42, 0, 1, 1],
	"ease-out": [0, 0, 0.58, 1],
	"ease-in-out": [0.42, 0, 0.58, 1],
};

function curveOf(ease: string): Curve | null {
	const key = ease.trim();
	const known = CURVES[key];
	if (known) return known;
	const numbers = /^cubic-bezier\(([^)]+)\)$/.exec(key)?.[1]?.split(",").map(Number);
	return numbers?.length === 4 && numbers.every(Number.isFinite) ? (numbers as unknown as Curve) : null;
}

const format = (curve: Curve) => `cubic-bezier(${curve.map((value) => Number(value.toFixed(4))).join(", ")})`;

function splitEase(ease: string | undefined, progress: number): [string | undefined, string | undefined] {
	const curve = ease && ease.trim() !== "linear" ? curveOf(ease) : null;
	if (!ease || !curve) return [ease, ease];
	const [x1, y1, x2, y2] = curve;
	const bezier = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
	let low = 0;
	let high = 1;
	for (let index = 0; index < 40; index += 1) {
		const mid = (low + high) / 2;
		if (bezier(x1, x2, mid) < progress) low = mid;
		else high = mid;
	}
	const t = (low + high) / 2;
	const lerp = (a: number, b: number) => a + (b - a) * t;
	const p01 = [lerp(0, x1), lerp(0, y1)] as const;
	const p12 = [lerp(x1, x2), lerp(y1, y2)] as const;
	const p23 = [lerp(x2, 1), lerp(y2, 1)] as const;
	const p012 = [lerp(p01[0], p12[0]), lerp(p01[1], p12[1])] as const;
	const p123 = [lerp(p12[0], p23[0]), lerp(p12[1], p23[1])] as const;
	const [x, y] = [lerp(p012[0], p123[0]), lerp(p012[1], p123[1])];
	if (x <= 0 || x >= 1 || Math.abs(y) < 1e-9 || Math.abs(1 - y) < 1e-9) return [ease, ease];
	return [
		format([p01[0] / x, p01[1] / y, p012[0] / x, p012[1] / y]),
		format([(p123[0] - x) / (1 - x), (p123[1] - y) / (1 - y), (p23[0] - x) / (1 - x), (p23[1] - y) / (1 - y)]),
	];
}

function withEase(keyframe: BoardKeyframe, ease: string | undefined): BoardKeyframe {
	const { ease: _ease, ...rest } = keyframe;
	return ease && ease !== "linear" ? { ...rest, ease } : rest;
}

function cutTrack(document: BoardDocument, track: BoardTrack, time: number): { before: BoardKeyframe[]; after: BoardKeyframe[] } {
	const { keyframes } = track;
	const index = keyframes.findIndex((keyframe) => keyframe.at >= time);
	const before = keyframes.filter((keyframe) => keyframe.at <= time);
	const after = keyframes.filter((keyframe) => keyframe.at >= time);
	const a = keyframes[index - 1];
	const b = keyframes[index];
	if (!a || !b || b.at === time) return { before, after };
	const value = cutValue(document, track, time).value;
	const [left, right] = track.interpolation === "step" ? [b.ease, b.ease] : splitEase(b.ease, (time - a.at) / (b.at - a.at));
	return { before: [...before, withEase({ at: time, value }, left)], after: [{ at: time, value }, withEase(b, right), ...after.slice(1)] };
}

export function boardSplitTarget(
	document: BoardDocument,
	animation: BoardAnimation,
	target: string,
	copies: ReadonlyMap<string, string>,
	at: number,
): BoardAnimation | null {
	const span = boardTargetSpan(document, animation, target);
	const time = Math.round(at);
	if (!span || time < span.start + BOARD_SPAN_MIN_MS || time > span.end - BOARD_SPAN_MIN_MS) return null;
	const tracks = { ...animation.tracks };
	for (const [id, track] of Object.entries(animation.tracks)) {
		const copy = copies.get(track.target);
		if (!copy) continue;
		const own = track.property === VISIBLE ? boardTargetSpan(document, animation, track.target) : null;
		let before: BoardKeyframe[];
		let after: BoardKeyframe[];
		if (own) {
			before = visibleKeyframes(own.start, Math.min(own.end, time));
			after = visibleKeyframes(Math.max(own.start, time), own.end);
		} else {
			// Each part keeps the keyframes around the cut, so every easing, step and spline moves as before.
			const index = track.keyframes.findIndex((keyframe) => keyframe.at >= time);
			const next = index < 0 ? track.keyframes.length : index;
			before = track.keyframes.slice(0, next + 2);
			after = track.keyframes.slice(Math.max(0, next - 2));
		}
		tracks[id] = { ...track, keyframes: before };
		tracks[newBoardTrackId(tracks, copy, track.property)] = { ...structuredClone(track), target: copy, keyframes: after };
	}
	const copy = copies.get(target) as string;
	if (document.items[target] && !findBoardKeyTrack(animation.tracks, target, VISIBLE)) {
		setTrack(tracks, target, VISIBLE, visibleKeyframes(span.start, time), "step");
		setTrack(tracks, copy, VISIBLE, visibleKeyframes(time, span.end), "step");
	}
	return { ...animation, tracks };
}

export function boardRemoveTarget(animation: BoardAnimation, target: string): BoardAnimation {
	const tracks = Object.fromEntries(Object.entries(animation.tracks).filter(([, track]) => track.target !== target));
	return Object.keys(tracks).length === Object.keys(animation.tracks).length ? animation : { ...animation, tracks };
}

function retime(
	animation: BoardAnimation,
	keyframes: (track: BoardTrack) => BoardKeyframe[],
	markers: BoardAnimation["markers"],
	duration: number,
): BoardAnimation {
	const tracks: Record<string, BoardTrack> = {};
	for (const [id, track] of Object.entries(animation.tracks)) {
		const next = track.property === VISIBLE ? normalizeVisible(keyframes(track)) : keyframes(track);
		if (track.property === VISIBLE) tracks[id] = { ...track, keyframes: next.length ? next : [{ at: 0, value: false }] };
		else if (next.length) tracks[id] = { ...track, keyframes: next };
	}
	return { ...animation, tracks, markers, duration: Math.max(1, Math.round(duration)) };
}

function join(before: BoardKeyframe[], after: BoardKeyframe[]): BoardKeyframe[] {
	const last = before.at(-1);
	const [first, second] = after;
	if (!last || !first || first.at !== last.at) return [...before, ...after];
	if (sameJson(first.value, last.value) || (second && second.at <= first.at + 1)) return [...before, ...after.slice(1)];
	return [...before, { ...first, at: first.at + 1 }, ...after.slice(1)];
}

export function boardRemoveTime(document: BoardDocument, animation: BoardAnimation, from: number, to: number): BoardAnimation {
	const start = Math.max(0, Math.round(Math.min(from, to)));
	const end = Math.round(Math.max(from, to));
	const length = end - start;
	if (length <= 0) return animation;
	return retime(
		animation,
		(track) => {
			const { before } = cutTrack(document, track, start);
			const after = shiftKeyframes(cutTrack(document, track, end).after, -length);
			return track.property === VISIBLE ? [...before, ...after] : join(before, after);
		},
		animation.markers.filter((marker) => marker.at <= start || marker.at >= end).map((marker) => (marker.at >= end ? { ...marker, at: marker.at - length } : marker)),
		animation.duration - (Math.min(end, animation.duration) - Math.min(start, animation.duration)),
	);
}

export function boardInsertTime(document: BoardDocument, animation: BoardAnimation, at: number, length: number): BoardAnimation {
	const time = Math.max(0, Math.round(at));
	const gap = Math.round(length);
	if (gap <= 0) return animation;
	return retime(
		animation,
		(track) => {
			const body = withoutAnchor(track);
			const anchor = track.keyframes.slice(0, track.keyframes.length - body.length);
			if ((body[0]?.at ?? 0) >= time) return [...anchor, ...shiftKeyframes(body, gap)];
			const { before, after } = cutTrack(document, track, time);
			return after.some((keyframe) => keyframe.at > time) ? [...before, ...shiftKeyframes(after, gap)] : before;
		},
		animation.markers.map((marker) => (marker.at > time ? { ...marker, at: marker.at + gap } : marker)),
		time < animation.duration ? animation.duration + gap : animation.duration,
	);
}
