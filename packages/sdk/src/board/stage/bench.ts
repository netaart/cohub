import type { BoardStage } from "./stage.js";

export type BoardBenchPhase = {
	name: string;
	frames: number;
	wheel: Pick<WheelEventInit, "deltaX" | "deltaY" | "ctrlKey">;
	rest?: number;
};

export type BoardBenchPercentiles = { p50: number; p95: number; max: number };

export type BoardBenchSettle = { shown: number; ready: number; loaded: number };

export type BoardBenchPhaseReport = BoardBenchSettle & {
	name: string;
	frame: BoardBenchPercentiles;
	work: BoardBenchPercentiles;
	long: number;
};

export type BoardBenchReport = { open: BoardBenchSettle; phases: BoardBenchPhaseReport[] };

const STEP: BoardBenchPhase = { name: "step", frames: 1, rest: 3_000, wheel: { deltaY: 960 } };

export const BOARD_BENCH_PHASES: readonly BoardBenchPhase[] = [
	{ name: "zoom in", frames: 15, wheel: { deltaY: -10, ctrlKey: true } },
	{ name: "close", frames: 12, wheel: { deltaY: -10, ctrlKey: true } },
	STEP,
	STEP,
	STEP,
	{ name: "pan close", frames: 60, wheel: { deltaX: -24, deltaY: 16 } },
	{ name: "zoom out", frames: 12, wheel: { deltaY: 10, ctrlKey: true } },
	{ name: "pan", frames: 120, wheel: { deltaX: 24 } },
	{ name: "overview", frames: 16, wheel: { deltaY: 10, ctrlKey: true } },
];

const SETTLE_LIMIT_MS = 20_000;
const LONG_FRAME_MS = 50;

function percentiles(values: number[]): BoardBenchPercentiles {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
	return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

async function settle(stage: BoardStage, since: number): Promise<BoardBenchSettle> {
	const times: Partial<BoardBenchSettle> = {};
	for (;;) {
		const now = await nextFrame();
		const { waiting, settling, loading } = stage.stats();
		const at = now - since;
		if (times.shown === undefined && waiting === 0) times.shown = at;
		if (times.ready === undefined && !settling) times.ready = at;
		if (times.loaded === undefined && !settling && loading === 0) times.loaded = at;
		if (times.loaded !== undefined || at >= SETTLE_LIMIT_MS)
			return {
				shown: times.shown ?? SETTLE_LIMIT_MS,
				ready: times.ready ?? SETTLE_LIMIT_MS,
				loaded: times.loaded ?? SETTLE_LIMIT_MS,
			};
	}
}

function measureFrameWork(): { take: () => number; stop: () => void } {
	const original = globalThis.requestAnimationFrame;
	let work = 0;
	globalThis.requestAnimationFrame = (callback) =>
		original((time) => {
			const start = performance.now();
			try {
				callback(time);
			} finally {
				work += performance.now() - start;
			}
		});
	return {
		take: () => {
			const taken = work;
			work = 0;
			return taken;
		},
		stop: () => {
			globalThis.requestAnimationFrame = original;
		},
	};
}

export async function runBoardStageBench(
	stage: BoardStage,
	{ since = performance.now(), phases = BOARD_BENCH_PHASES }: { since?: number; phases?: readonly BoardBenchPhase[] } = {},
): Promise<BoardBenchReport> {
	await stage.ready;
	const canvas = stage.renderer?.canvas as HTMLCanvasElement | undefined;
	if (!canvas) throw new Error("Board stage has no canvas.");
	const open = await settle(stage, since);
	const rect = canvas.getBoundingClientRect();
	const work = measureFrameWork();
	try {
		const reports: BoardBenchPhaseReport[] = [];
		for (const phase of phases) {
			if (phase.rest) await new Promise((resolve) => setTimeout(resolve, phase.rest));
			const intervals: number[] = [];
			const costs: number[] = [];
			let previous = await nextFrame();
			for (let frame = 0; frame < phase.frames; frame += 1) {
				canvas.dispatchEvent(
					new WheelEvent("wheel", {
						bubbles: true,
						cancelable: true,
						clientX: rect.left + rect.width / 2,
						clientY: rect.top + rect.height / 2,
						...phase.wheel,
					}),
				);
				work.take();
				const now = await nextFrame();
				costs.push(work.take());
				intervals.push(now - previous);
				previous = now;
			}
			reports.push({
				name: phase.name,
				frame: percentiles(intervals),
				work: percentiles(costs),
				long: intervals.filter((interval) => interval > LONG_FRAME_MS).length,
				...(await settle(stage, previous)),
			});
		}
		return { open, phases: reports };
	} finally {
		work.stop();
	}
}
