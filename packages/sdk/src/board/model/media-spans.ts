import { parseBoardMediaSource } from "@cohub/protocol/board-model";
import type { BoardScene } from "./scene.js";

export type BoardMediaState = {
	id: string;
	kind: "video" | "audio";
	src: string;
	time: number;
	volume: number;
	shown: boolean;
	loop?: boolean;
};

export type BoardMediaSpan = {
	id: string;
	kind: "video" | "audio";
	src: string;
	start: number;
	end: number;
	from: number;
	rate: number;
	volume: Array<{ at: number; value: number }>;
};

export const BOARD_MEDIA_RATES = { min: 0.25, max: 4 } as const;

export function boardTimedMedia(scene: BoardScene, ids?: Iterable<string>): BoardMediaState[] {
	const result: BoardMediaState[] = [];
	const items = ids ? Array.from(ids, (id) => scene.get(id)) : scene.items;
	for (const item of items) {
		if (item?.type !== "video" && item?.type !== "audio") continue;
		const { time, volume, src } = item.props;
		if (time === undefined || !parseBoardMediaSource(src)) continue;
		result.push({ id: item.id, kind: item.type, src, time, volume: volume ?? 1, shown: scene.shown(item.id) });
	}
	return result;
}

export function boardMediaRate(from: { at: number; time: number }, to: { at: number; time: number }): number {
	const elapsed = to.at - from.at;
	if (elapsed <= 0) return 0;
	const rate = (to.time - from.time) / elapsed;
	return rate >= BOARD_MEDIA_RATES.min && rate <= BOARD_MEDIA_RATES.max ? rate : 0;
}

function sameRate(a: number, b: number): boolean {
	return Math.abs(a - b) <= 0.01 * Math.max(a, b);
}

function simplify(points: Array<{ at: number; value: number }>): Array<{ at: number; value: number }> {
	const result: Array<{ at: number; value: number }> = [];
	for (const point of points) {
		const a = result.at(-2);
		const b = result.at(-1);
		if (a && b && point.at > a.at && Math.abs(a.value + ((b.at - a.at) / (point.at - a.at)) * (point.value - a.value) - b.value) < 1e-3) result.pop();
		result.push(point);
	}
	return result;
}

export function boardMediaSpans(samples: Iterable<{ at: number; media: readonly BoardMediaState[] }>): BoardMediaSpan[] {
	const spans: BoardMediaSpan[] = [];
	const open = new Map<string, BoardMediaSpan>();
	const previous = new Map<string, { at: number; state: BoardMediaState }>();
	for (const { at, media } of samples) {
		const seen = new Set<string>();
		for (const state of media) {
			seen.add(state.id);
			const before = previous.get(state.id);
			previous.set(state.id, { at, state });
			const span = open.get(state.id);
			const rate = before?.state.shown && state.shown && before.state.src === state.src ? boardMediaRate({ at: before.at, time: before.state.time }, { at, time: state.time }) : 0;
			if (span && rate && sameRate(rate, span.rate)) {
				span.end = at;
				span.volume.push({ at, value: state.volume });
				continue;
			}
			if (span) open.delete(state.id);
			if (!before || !rate) continue;
			const next: BoardMediaSpan = {
				id: state.id,
				kind: state.kind,
				src: state.src,
				start: before.at,
				end: at,
				from: before.state.time,
				rate,
				volume: [{ at: before.at, value: before.state.volume }, { at, value: state.volume }],
			};
			open.set(state.id, next);
			spans.push(next);
		}
		for (const id of open.keys()) if (!seen.has(id)) open.delete(id);
		for (const id of previous.keys()) if (!seen.has(id)) previous.delete(id);
	}
	for (const span of spans) span.volume = simplify(span.volume);
	return spans;
}
