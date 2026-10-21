import { boardTextResolution } from "../render/text-resolution.js";

export function createTextResolutionTracker(settleMs: number, onSettle: () => void) {
	let target = 0;
	let value = 0;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	return {
		get value() {
			return value;
		},
		update(next: number): number {
			if (next !== target) {
				target = next;
				settled = false;
				if (timer !== null) clearTimeout(timer);
				timer = setTimeout(() => {
					timer = null;
					settled = true;
					onSettle();
				}, settleMs);
			}
			value = boardTextResolution(target, value, settled);
			return value;
		},
		dispose() {
			if (timer !== null) clearTimeout(timer);
			timer = null;
		},
	};
}
