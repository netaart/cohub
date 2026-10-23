// Deferred work admits what its measured cost fits in a share of the frame; it at most
// doubles per frame, halves on dropped frames while moving, and keeps an eighth of the batch.
export type BoardFrameWork = "materialize" | "plate" | "resolution";

export type BoardFrameBudget = {
	allow(kind: BoardFrameWork): number;
	spend(kind: BoardFrameWork, units: number, ms: number): void;
};

export type BoardFrameClock = BoardFrameBudget & {
	begin(frameTime: number, options: { moving: boolean; chained: boolean }): void;
	readonly interval: number;
};

const INITIAL: Record<BoardFrameWork, number> = { materialize: 48, plate: 2400, resolution: 32 };
const KINDS = Object.keys(INITIAL) as readonly BoardFrameWork[];
const MIN_SHARE = 1 / 8;
const LATE_FRAMES = 1.5;
const MOVING_SHARE = 0.25;
const RESTING_SHARE = 0.6;
const COST_SMOOTHING = 0.3;
const DEFAULT_INTERVAL = 1000 / 60;
const MIN_INTERVAL = 4;
const INTERVAL_DRIFT = 1.01;

const perKind = (value: number): Record<BoardFrameWork, number> => ({ materialize: value, plate: value, resolution: value });

export function fixedBoardFrameBudget(): BoardFrameBudget & { reset(): void } {
	let done = perKind(0);
	return {
		allow: (kind) => Math.max(0, INITIAL[kind] - done[kind]),
		spend(kind, units) {
			done[kind] += units;
		},
		reset() {
			done = perKind(0);
		},
	};
}

export function createBoardFrameClock(now: () => number = () => performance.now()): BoardFrameClock {
	let interval = DEFAULT_INTERVAL;
	let previous = Number.NaN;
	let deadline = Number.POSITIVE_INFINITY;
	let late = false;
	const cost = perKind(0);
	for (const kind of KINDS) cost[kind] = (DEFAULT_INTERVAL * MOVING_SHARE) / INITIAL[kind];
	const last = perKind(0);
	let done = perKind(0);

	return {
		get interval() {
			return interval;
		},
		begin(frameTime, { moving, chained }) {
			const delta = frameTime - previous;
			previous = frameTime;
			late = moving && chained && delta > interval * LATE_FRAMES;
			if (chained && delta >= MIN_INTERVAL) interval = Math.min(interval * INTERVAL_DRIFT, delta);
			deadline = now() + interval * (moving ? MOVING_SHARE : RESTING_SHARE);
			for (const kind of KINDS) if (done[kind] > 0) last[kind] = done[kind];
			done = perKind(0);
		},
		allow(kind) {
			const floor = Math.ceil(INITIAL[kind] * MIN_SHARE);
			const fit = Math.floor((deadline - now()) / cost[kind]);
			const ceiling = late ? Math.floor(last[kind] / 2) : Math.max(INITIAL[kind], last[kind] * 2);
			return Math.max(done[kind] === 0 ? floor : 0, Math.min(fit, ceiling - done[kind]));
		},
		spend(kind, units, ms) {
			if (units <= 0) return;
			done[kind] += units;
			cost[kind] += (Math.max(ms, 0.001) / units - cost[kind]) * COST_SMOOTHING;
		},
	};
}
