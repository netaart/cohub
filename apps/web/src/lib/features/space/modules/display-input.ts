import {
	DISPLAY_MODIFIER_KEYS,
	type DisplayInputEvent,
	type DisplayModifierKey,
	type DisplayPlatform,
	splitDisplayText,
} from "@cohub/protocol/display";
import { isApplePlatform } from "$lib/keyboard";

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
const TEXT_PIECES_PER_BATCH = 8;

export function isNamedKey(key: string): boolean {
	return EDITING_KEYS.has(key) || FUNCTION_KEY.test(key);
}

export function textBatches(text: string): DisplayInputEvent[][] {
	const pieces = splitDisplayText(text).map(
		(piece): DisplayInputEvent => ({ type: "text", text: piece }),
	);
	const batches: DisplayInputEvent[][] = [];
	for (let index = 0; index < pieces.length; index += TEXT_PIECES_PER_BATCH)
		batches.push(pieces.slice(index, index + TEXT_PIECES_PER_BATCH));
	return batches;
}

type Modifiers = {
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
};

type Keystroke = Modifiers & {
	key: string;
	code?: string;
	isComposing?: boolean;
	getModifierState?: (key: string) => boolean;
};

export type KeyInput = {
	events: DisplayInputEvent[];
	held: DisplayModifierKey[];
};

export function remoteMeta(
	platform: DisplayPlatform | undefined,
	appleClient = isApplePlatform(),
): DisplayModifierKey {
	return appleClient && platform && platform !== "macos" ? "Control" : "Meta";
}

export function eventModifiers(
	event: Modifiers,
	meta: DisplayModifierKey = "Meta",
): DisplayModifierKey[] {
	const on: Record<DisplayModifierKey, boolean> = {
		Control: event.ctrlKey,
		Alt: event.altKey,
		Shift: event.shiftKey,
		Meta: false,
	};
	if (event.metaKey) on[meta] = true;
	return DISPLAY_MODIFIER_KEYS.filter((key) => on[key]);
}

const CODE_KEYS: Record<string, string> = {
	Space: " ",
	Minus: "-",
	Equal: "=",
	BracketLeft: "[",
	BracketRight: "]",
	Backslash: "\\",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Backquote: "`",
};

function baseKey({ key, code = "" }: Keystroke): string | null {
	if (/^[a-z]$/i.test(key)) return key.toLowerCase();
	if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
	if (/^Digit\d$/.test(code)) return code.slice(5);
	return CODE_KEYS[code] ?? ([...key].length === 1 ? key.toLowerCase() : null);
}

export function keyboardInput(
	event: Keystroke,
	desktop = false,
	meta: DisplayModifierKey = "Meta",
): KeyInput | null {
	if (event.isComposing) return null;
	const printable = [...event.key].length === 1;
	if (!desktop) {
		const shortcut = event.ctrlKey || event.metaKey;
		if (printable && !shortcut)
			return { events: [{ type: "text", text: event.key }], held: [] };
		return !shortcut && EDITING_KEYS.has(event.key)
			? { events: [{ type: "key", action: "press", key: event.key }], held: [] }
			: null;
	}
	const altGraph = event.getModifierState?.("AltGraph") ?? false;
	const shortcut =
		!altGraph && (event.ctrlKey || event.metaKey || event.altKey);
	if (printable && !shortcut)
		return { events: [{ type: "text", text: event.key }], held: [] };
	const key = isNamedKey(event.key)
		? event.key
		: shortcut
			? baseKey(event)
			: null;
	if (!key || ((event.ctrlKey || event.metaKey) && key === "v")) return null;
	return {
		events: [{ type: "key", action: "press", key }],
		held: eventModifiers(event, meta),
	};
}

export function createModifierSync() {
	let held: readonly DisplayModifierKey[] = [];
	const event =
		(action: "down" | "up") =>
		(key: DisplayModifierKey): DisplayInputEvent => ({
			type: "key",
			action,
			key,
		});
	return {
		get held() {
			return held;
		},
		to(target: readonly DisplayModifierKey[]): DisplayInputEvent[] {
			const events = [
				...held.filter((key) => !target.includes(key)).map(event("up")),
				...DISPLAY_MODIFIER_KEYS.filter(
					(key) => target.includes(key) && !held.includes(key),
				).map(event("down")),
			];
			held = DISPLAY_MODIFIER_KEYS.filter((key) => target.includes(key));
			return events;
		},
		around(
			target: readonly DisplayModifierKey[],
			events: DisplayInputEvent[],
		): DisplayInputEvent[] {
			const before = held;
			return [...this.to(target), ...events, ...this.to(before)];
		},
		forget() {
			held = DISPLAY_MODIFIER_KEYS;
		},
		clear() {
			held = [];
		},
	};
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
