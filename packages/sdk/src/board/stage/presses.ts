import { BOARD_HAND_TAP_SLOP } from "../editor/index.js";

export const BOARD_LONG_PRESS_MS = 450;
const GHOST_CLICK_MS = 700;

export type BoardStagePress = {
	pointerId: number;
	pointerType: string;
	clientX: number;
	clientY: number;
};

export function boardStagePress(event: PointerEvent): BoardStagePress {
	return { pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY };
}

export function createBoardLongPress(fire: (press: BoardStagePress) => void) {
	let pending: { press: BoardStagePress; timer: ReturnType<typeof setTimeout> } | null = null;
	const cancel = () => {
		if (pending) clearTimeout(pending.timer);
		pending = null;
	};
	return {
		start(event: PointerEvent) {
			if (pending) return cancel();
			if (event.pointerType === "mouse" || event.button !== 0) return;
			const press = boardStagePress(event);
			pending = {
				press,
				timer: setTimeout(() => {
					pending = null;
					fire(press);
				}, BOARD_LONG_PRESS_MS),
			};
		},
		move(event: PointerEvent) {
			if (!pending || event.pointerId !== pending.press.pointerId) return;
			const { clientX, clientY } = pending.press;
			if (Math.hypot(event.clientX - clientX, event.clientY - clientY) > BOARD_HAND_TAP_SLOP) cancel();
		},
		end(event: PointerEvent) {
			if (pending?.press.pointerId === event.pointerId) cancel();
		},
		cancel,
	};
}

export function createGhostClickGuard(view: Window | null) {
	let disarm: (() => void) | null = null;
	return {
		arm() {
			disarm?.();
			if (!view) return;
			const drop = (event: Event) => {
				event.preventDefault();
				event.stopImmediatePropagation();
				disarm?.();
			};
			const timer = setTimeout(() => disarm?.(), GHOST_CLICK_MS);
			view.addEventListener("click", drop, true);
			disarm = () => {
				clearTimeout(timer);
				view.removeEventListener("click", drop, true);
				disarm = null;
			};
		},
		dispose: () => disarm?.(),
	};
}
