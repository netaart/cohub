import { FLICK_VELOCITY_PX_PER_MS } from "$lib/gestures/axis-lock";

export type PagerSample = { t: number; x: number };
export type PagerGlide = { duration: number; easing: string };

const VELOCITY_WINDOW_MS = 100;
const REST_MS = VELOCITY_WINDOW_MS / 2;
const FLICK_MIN_PX = 24;
const GLIDE_MIN_MS = 140;
const GLIDE_MAX_MS = 240;

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

export function addSample(samples: PagerSample[], t: number, x: number) {
	samples.push({ t, x });
	while (samples.length > 1 && t - samples[0].t > VELOCITY_WINDOW_MS)
		samples.shift();
}

export function releasePage(options: {
	samples: readonly PagerSample[];
	originX: number;
	releasedAt: number;
	position: number;
	count: number;
}) {
	const { samples, originX, releasedAt, position, count } = options;
	const first = samples[0];
	const last = samples.at(-1);
	const moving = last && releasedAt - last.t < REST_MS;
	const velocity =
		first && moving && last.t > first.t
			? (last.x - first.x) / (last.t - first.t)
			: 0;
	const moved = (last?.x ?? originX) - originX;
	const flick =
		Math.abs(velocity) >= FLICK_VELOCITY_PX_PER_MS &&
		Math.abs(moved) >= FLICK_MIN_PX;
	const target = flick
		? velocity < 0
			? Math.floor(position) + 1
			: Math.ceil(position) - 1
		: Math.round(position);
	return { target: clamp(target, 0, count - 1), speed: Math.abs(velocity) };
}

export function glideTiming(distancePx: number, speed: number): PagerGlide {
	const duration = clamp(
		(2 * distancePx) / Math.max(speed, 1),
		GLIDE_MIN_MS,
		GLIDE_MAX_MS,
	);
	const y1 = clamp(((speed * duration) / distancePx) * 0.25, 0.4, 1);
	return { duration, easing: `cubic-bezier(0.25, ${y1}, 0.3, 1)` };
}
