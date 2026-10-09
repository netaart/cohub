import { createSubscriber } from "svelte/reactivity";

const TICK_MS = 1_000;

const subscribe = createSubscriber((update) => {
	const timer = setInterval(update, TICK_MS);
	return () => clearInterval(timer);
});

/**
 * One shared second tick: however many elapsed timers render, a single
 * interval runs, and only while something reads `clock.now` in an effect.
 */
export const clock = {
	get now() {
		subscribe();
		return Date.now();
	},
};
