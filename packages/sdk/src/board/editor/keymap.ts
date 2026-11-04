import type { BoardRegionStep } from "../model/index.js";
import type { BoardEditor } from "./editor.js";
import type { BoardToolId } from "./tool.js";

export type BoardKeyCommand =
	| { type: "tool"; tool: BoardToolId }
	| { type: "nudge"; dx: number; dy: number; large: boolean }
	| { type: "frame"; step: BoardRegionStep; enter: boolean }
	| {
			type:
				| "undo"
				| "redo"
				| "duplicate"
				| "selectAll"
				| "copy"
				| "cut"
				| "paste"
				| "delete"
				| "lock"
				| "export"
				| "open"
				| "escape"
				| "zoomIn"
				| "zoomOut"
				| "zoomReset"
				| "zoomFit"
				| "zoomSelection";
	  };

export type BoardKeyEvent = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat" | "target"> & {
	preventDefault(): void;
};

const TOOL_KEYS: Readonly<Record<string, BoardToolId>> = {
	v: "select",
	h: "hand",
	t: "text",
	s: "shape",
	r: "shape",
	d: "draw",
	p: "draw",
	a: "arrow",
	f: "frame",
};

const NUDGES: Readonly<Record<string, readonly [number, number]>> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};

const FRAME_KEYS: Readonly<Record<string, BoardRegionStep>> = {
	PageDown: "next",
	PageUp: "previous",
	Home: "first",
	End: "last",
};

const READONLY_COMMANDS = new Set<BoardKeyCommand["type"]>([
	"nudge",
	"frame",
	"selectAll",
	"copy",
	"export",
	"open",
	"escape",
	"zoomIn",
	"zoomOut",
	"zoomReset",
	"zoomFit",
	"zoomSelection",
]);

const PRESENT_COMMANDS = new Set<BoardKeyCommand["type"]>(["nudge", "frame", "escape"]);

const HOST_COMMANDS = new Set<BoardKeyCommand["type"]>(["copy", "cut", "paste", "export"]);

export function boardKeyCommand(event: BoardKeyEvent): BoardKeyCommand | null {
	const mod = event.metaKey || event.ctrlKey;
	const key = event.key.toLowerCase();
	if (mod) {
		if (event.altKey) return null;
		switch (key) {
			case "z":
				return { type: event.shiftKey ? "redo" : "undo" };
			case "y":
				return { type: "redo" };
			case "d":
				return { type: "duplicate" };
			case "a":
				return { type: "selectAll" };
			case "c":
				return { type: "copy" };
			case "x":
				return { type: "cut" };
			case "v":
				return { type: "paste" };
			case "l":
				return { type: "lock" };
			case "e":
				return event.shiftKey ? { type: "export" } : null;
			case "0":
				return { type: "zoomFit" };
			default:
				return null;
		}
	}
	if (event.altKey) return null;
	if (event.shiftKey) {
		if (event.code === "Digit0") return { type: "zoomReset" };
		if (event.code === "Digit1") return { type: "zoomFit" };
		if (event.code === "Digit2") return { type: "zoomSelection" };
	}
	const nudge = NUDGES[event.key];
	if (nudge) return { type: "nudge", dx: nudge[0], dy: nudge[1], large: event.shiftKey };
	if (key === "n") return { type: "frame", step: event.shiftKey ? "previous" : "next", enter: true };
	const frameStep = event.shiftKey ? undefined : FRAME_KEYS[event.key];
	if (frameStep) return { type: "frame", step: frameStep, enter: false };
	switch (event.key) {
		case "Delete":
		case "Backspace":
			return { type: "delete" };
		case "Enter":
			return { type: "open" };
		case "Escape":
			return { type: "escape" };
		case "=":
		case "+":
			return { type: "zoomIn" };
		case "-":
		case "_":
			return { type: "zoomOut" };
		case "/":
			return { type: "zoomFit" };
	}
	const tool = event.shiftKey ? undefined : TOOL_KEYS[key];
	return tool ? { type: "tool", tool } : null;
}

function isTypingTarget(target: EventTarget | null): boolean {
	const element = target as HTMLElement | null;
	if (!element || typeof element.closest !== "function") return false;
	return element.isContentEditable || element.closest("input, textarea, select, [contenteditable='true']") !== null;
}

const SELECTION_EDITS: ReadonlySet<BoardKeyCommand["type"]> = new Set(["duplicate", "selectAll", "delete", "lock"]);

export function runBoardKeyCommand(editor: BoardEditor, command: BoardKeyCommand): boolean {
	if (editor.tool === "play" && SELECTION_EDITS.has(command.type)) return false;
	switch (command.type) {
		case "tool":
			if (editor.tool === "play" || (editor.readonly && command.tool !== "select" && command.tool !== "hand")) return false;
			editor.tool = command.tool;
			return true;
		case "nudge": {
			const browsing = editor.readonly || editor.tool === "play" || editor.selection.length === 0;
			if (editor.frameView && browsing)
				return editor.stepFrame(command.dx ? (command.dx > 0 ? "right" : "left") : command.dy > 0 ? "down" : "up");
			if (browsing) return false;
			editor.nudgeSelection(command.dx, command.dy, command.large);
			return true;
		}
		case "frame":
			if (!command.enter && !editor.frameView) return false;
			return editor.stepFrame(command.step);
		case "undo":
			editor.undo();
			return true;
		case "redo":
			editor.redo();
			return true;
		case "duplicate":
			if (editor.selection.length === 0) return false;
			editor.duplicateSelection();
			return true;
		case "selectAll":
			editor.selectAll();
			return true;
		case "delete":
			if (editor.selection.length === 0) return false;
			editor.deleteSelection();
			return true;
		case "lock":
			if (editor.selection.length === 0) return false;
			editor.toggleSelectionLock();
			return true;
		case "escape":
			if (editor.gestureActive) editor.cancelPointerInteraction();
			else if (editor.frameView?.present) editor.exitFrameView();
			else if (editor.enteredId) editor.enteredId = null;
			else if (editor.editingId) editor.editingId = null;
			else if (editor.selection.length > 0) editor.clearSelection();
			else if (editor.frameView) editor.exitFrameView();
			else if (editor.tool !== "select" && editor.tool !== "hand" && editor.tool !== "play") editor.tool = "select";
			else return false;
			return true;
		case "zoomIn":
			editor.zoomIn();
			return true;
		case "zoomOut":
			editor.zoomOut();
			return true;
		case "zoomReset":
			editor.resetZoom();
			return true;
		case "zoomFit":
			editor.fitView();
			return true;
		case "zoomSelection":
			if (!editor.hasFocusableSelection) return false;
			editor.focusSelection();
			return true;
		case "open": {
			const [item] = editor.selectedItems;
			if (editor.readonly || editor.selection.length !== 1 || !item || item.locked || !editor.registry.capabilities(item).canEdit) return false;
			editor.editingId = item.id;
			return true;
		}
		default:
			return false;
	}
}

export function handleBoardKeyDown(editor: BoardEditor, event: BoardKeyEvent, host?: (command: BoardKeyCommand) => boolean): boolean {
	if ((editor.editingId || editor.enteredId) && event.key !== "Escape") return false;
	if (isTypingTarget(event.target)) return false;
	const presenting = editor.frameView?.present === true;
	if (presenting && event.key === " ") {
		event.preventDefault();
		return editor.stepFrame(event.shiftKey ? "previous" : "next");
	}
	if (event.key === " " && !event.metaKey && !event.ctrlKey) {
		event.preventDefault();
		if (!event.repeat) editor.spaceHeld = true;
		return true;
	}
	const command = boardKeyCommand(event);
	if (!command) return false;
	if (presenting && !PRESENT_COMMANDS.has(command.type)) return false;
	if (editor.readonly && command.type !== "tool" && !READONLY_COMMANDS.has(command.type)) return false;
	const handled = host?.(command) === true || (!HOST_COMMANDS.has(command.type) && runBoardKeyCommand(editor, command));
	if (handled) event.preventDefault();
	return handled;
}

export function handleBoardKeyUp(editor: BoardEditor, event: Pick<KeyboardEvent, "key">): void {
	if (event.key === " ") editor.spaceHeld = false;
}
