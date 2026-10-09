import {
	type DisplayInputEvent,
	type DisplayModifierKey,
	displayKeyEvents,
} from "@cohub/protocol/display";

export type Rect = { left: number; top: number; width: number; height: number };

export function containedRect(
	box: Rect,
	videoWidth: number,
	videoHeight: number,
): Rect {
	if (videoWidth <= 0 || videoHeight <= 0 || box.width <= 0 || box.height <= 0)
		return box;
	const scale = Math.min(box.width / videoWidth, box.height / videoHeight);
	const width = videoWidth * scale;
	const height = videoHeight * scale;
	return {
		left: box.left + (box.width - width) / 2,
		top: box.top + (box.height - height) / 2,
		width,
		height,
	};
}

export function toDisplayPoint(
	clientX: number,
	clientY: number,
	content: Rect,
	clamp = false,
): { x: number; y: number } | null {
	if (content.width <= 0 || content.height <= 0) return null;
	const x = (clientX - content.left) / content.width;
	const y = (clientY - content.top) / content.height;
	if (clamp)
		return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
	return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}

const EDITING_KEYS = new Set([
	"Enter",
	"Backspace",
	"Delete",
	"Escape",
	"Tab",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);
const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

type Keystroke = {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey?: boolean;
	isComposing?: boolean;
};

export function keyboardInput(
	event: Keystroke,
	desktop = false,
): DisplayInputEvent[] {
	if (event.isComposing) return [];
	const printable = [...event.key].length === 1;
	const shortcut = event.ctrlKey || event.metaKey;
	if (printable && !shortcut) return [{ type: "text", text: event.key }];
	if (!desktop) {
		return !shortcut && EDITING_KEYS.has(event.key)
			? [{ type: "key", action: "press", key: event.key }]
			: [];
	}
	if (
		!printable &&
		!EDITING_KEYS.has(event.key) &&
		!FUNCTION_KEY.test(event.key)
	)
		return [];
	if (shortcut && event.key.toLowerCase() === "v") return [];
	const modifiers: DisplayModifierKey[] = [];
	if (event.ctrlKey) modifiers.push("Control");
	if (event.altKey) modifiers.push("Alt");
	if (event.shiftKey) modifiers.push("Shift");
	if (event.metaKey) modifiers.push("Meta");
	return displayKeyEvents(
		printable ? event.key.toLowerCase() : event.key,
		modifiers,
	);
}

const LINE_PIXELS = 16;

export function wheelFraction(
	delta: number,
	deltaMode: number,
	extent: number,
): number {
	if (extent <= 0) return 0;
	const pixels =
		deltaMode === 1
			? delta * LINE_PIXELS
			: deltaMode === 2
				? delta * extent
				: delta;
	return Math.max(-1, Math.min(1, pixels / extent));
}
