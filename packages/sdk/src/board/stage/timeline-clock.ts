// A smooth wall clock for frames that leans toward a playing soundtrack instead of nudging it.

const RESYNC_MS = 250;
const TRACK = 0.002;
const LEAD_GAIN = 0.1;
const LEAD_SLEW = 0.25;
const LEAD_MAX_MS = 250;

export type BoardTimelineClock = {
	at(now: number): number;
	lead(skew: number | null, anchor: string | null, elapsed: number): void;
};

export function createBoardTimelineClock(wall: () => number = Date.now): BoardTimelineClock {
	let base = Number.NaN;
	let offset = 0;
	let anchor: string | null = null;
	return {
		at(now) {
			const drift = wall() - (base + now);
			if (Math.abs(drift) < RESYNC_MS) base += drift * TRACK;
			else base = wall() - now;
			return base + now + offset;
		},
		lead(skew, next, elapsed) {
			if (next !== anchor) {
				anchor = next;
				offset = 0;
				return;
			}
			if (skew === null || !(elapsed > 0)) return;
			const step = Math.min(LEAD_SLEW * elapsed, Math.max(-LEAD_SLEW * elapsed, skew * LEAD_GAIN));
			offset = Math.min(LEAD_MAX_MS, Math.max(-LEAD_MAX_MS, offset + step));
		},
	};
}
