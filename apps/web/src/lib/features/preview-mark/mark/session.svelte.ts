import { normalizeCropRect } from "../capture/geometry.ts";
import type {
	CropRect,
	FrozenFrame,
	MarkColor,
	MarkTool,
	Point,
	Stroke,
} from "../types.ts";
import { strokesAfterCrop } from "./transform.ts";

function uid() {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultStrokeWidth(frame: FrozenFrame) {
	// Slightly bold so marks stay readable on dense UI screenshots.
	return Math.max(3.5, Math.min(frame.width, frame.height) * 0.005);
}

export function createMarkSession(initial: FrozenFrame) {
	let frame = $state<FrozenFrame>(initial);
	let originalFrame = $state<FrozenFrame>(initial);
	let strokes = $state<Stroke[]>([]);
	let tool = $state<MarkTool>("pen");
	let color = $state<MarkColor>("brand");
	let draft = $state<Stroke | null>(null);
	let cropDraft = $state<{ a: Point; b: Point } | null>(null);
	let strokeWidth = $state(defaultStrokeWidth(initial));

	function safeClose(bitmap: ImageBitmap) {
		try {
			bitmap.close();
		} catch {
			// already closed
		}
	}

	function replaceCapture(next: FrozenFrame) {
		if (frame.bitmap !== originalFrame.bitmap) safeClose(frame.bitmap);
		safeClose(originalFrame.bitmap);
		originalFrame = next;
		frame = next;
		strokes = [];
		draft = null;
		cropDraft = null;
		strokeWidth = defaultStrokeWidth(next);
		tool = "pen";
	}

	/** Switch tools without leaking unfinished drafts across modes. */
	function setTool(next: MarkTool) {
		if (next === tool) return;
		draft = null;
		// Crop selection is mode-local; leaving or re-entering crop abandons it.
		if (tool === "crop" || next === "crop") cropDraft = null;
		tool = next;
	}

	function setColor(next: MarkColor) {
		if (tool === "crop") return;
		color = next;
	}

	function pointerToFrame(
		clientX: number,
		clientY: number,
		surface: DOMRect,
	): Point {
		const x =
			((clientX - surface.left) / Math.max(1, surface.width)) * frame.width;
		const y =
			((clientY - surface.top) / Math.max(1, surface.height)) * frame.height;
		return {
			x: Math.max(0, Math.min(frame.width, x)),
			y: Math.max(0, Math.min(frame.height, y)),
		};
	}

	function beginStroke(point: Point) {
		if (tool === "crop") {
			cropDraft = { a: point, b: point };
			draft = null;
			return;
		}
		const width = strokeWidth;
		if (tool === "pen") {
			draft = {
				id: uid(),
				tool: "pen",
				color,
				points: [point],
				width,
			};
			return;
		}
		if (tool === "arrow") {
			draft = {
				id: uid(),
				tool: "arrow",
				color,
				from: point,
				to: point,
				width,
			};
			return;
		}
		draft = {
			id: uid(),
			tool: "rect",
			color,
			a: point,
			b: point,
			width,
		};
	}

	function moveStroke(point: Point) {
		if (tool === "crop") {
			if (!cropDraft) return;
			cropDraft = { ...cropDraft, b: point };
			return;
		}
		if (!draft) return;
		if (draft.tool === "pen") {
			const last = draft.points[draft.points.length - 1];
			if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.8) return;
			draft = { ...draft, points: [...draft.points, point] };
			return;
		}
		if (draft.tool === "arrow") {
			draft = { ...draft, to: point };
			return;
		}
		draft = { ...draft, b: point };
	}

	function endStroke() {
		if (tool === "crop") {
			// Crop applied explicitly via applyCropDraft.
			return;
		}
		if (!draft) return;
		const committed = draft;
		draft = null;
		if (committed.tool === "pen" && committed.points.length === 0) return;
		if (
			committed.tool === "arrow" &&
			committed.from.x === committed.to.x &&
			committed.from.y === committed.to.y
		) {
			return;
		}
		if (
			committed.tool === "rect" &&
			committed.a.x === committed.b.x &&
			committed.a.y === committed.b.y
		) {
			return;
		}
		strokes = [...strokes, committed];
	}

	function cancelDraft() {
		draft = null;
		cropDraft = null;
	}

	function getCropRect(): CropRect | null {
		if (!cropDraft) return null;
		const rect = normalizeCropRect(
			cropDraft.a,
			cropDraft.b,
			frame.width,
			frame.height,
		);
		if (rect.width < 4 || rect.height < 4) return null;
		return rect;
	}

	async function applyCropDraft(): Promise<boolean> {
		const rect = getCropRect();
		if (!rect) return false;
		const cropped = await createImageBitmap(
			frame.bitmap,
			rect.x,
			rect.y,
			rect.width,
			rect.height,
		);
		const next: FrozenFrame = {
			...frame,
			bitmap: cropped,
			width: cropped.width,
			height: cropped.height,
			capturedAt: Date.now(),
		};
		// Keep originalFrame so Reset can restore the capture.
		if (frame.bitmap !== originalFrame.bitmap) safeClose(frame.bitmap);
		// Rebase existing marks into the cropped frame instead of wiping them.
		strokes = strokesAfterCrop(strokes, rect);
		frame = next;
		draft = null;
		cropDraft = null;
		strokeWidth = defaultStrokeWidth(next);
		tool = "pen";
		return true;
	}

	function resetCrop() {
		if (frame.bitmap === originalFrame.bitmap) {
			cropDraft = null;
			return;
		}
		safeClose(frame.bitmap);
		frame = originalFrame;
		// Cropped-space marks no longer map to the original frame.
		strokes = [];
		draft = null;
		cropDraft = null;
		strokeWidth = defaultStrokeWidth(frame);
		tool = "pen";
	}

	function undo() {
		if (draft || cropDraft) {
			draft = null;
			cropDraft = null;
			return;
		}
		if (strokes.length === 0) return;
		strokes = strokes.slice(0, -1);
	}

	function clear() {
		strokes = [];
		draft = null;
		// Clear marks only — keep applied crop and abandon unfinished crop draft.
		cropDraft = null;
	}

	function dispose() {
		if (frame.bitmap !== originalFrame.bitmap) safeClose(frame.bitmap);
		safeClose(originalFrame.bitmap);
	}

	return {
		get frame() {
			return frame;
		},
		get strokes() {
			return strokes;
		},
		get draft() {
			return draft;
		},
		get cropDraft() {
			return cropDraft;
		},
		get tool() {
			return tool;
		},
		get color() {
			return color;
		},
		get strokeWidth() {
			return strokeWidth;
		},
		get canUndo() {
			return strokes.length > 0 || Boolean(draft) || Boolean(cropDraft);
		},
		get canClear() {
			return strokes.length > 0 || Boolean(draft) || Boolean(cropDraft);
		},
		get isCropped() {
			return frame.bitmap !== originalFrame.bitmap;
		},
		get isDirty() {
			return (
				strokes.length > 0 ||
				Boolean(draft) ||
				Boolean(cropDraft) ||
				frame.bitmap !== originalFrame.bitmap
			);
		},
		get allStrokes(): Stroke[] {
			return draft ? [...strokes, draft] : strokes;
		},
		setTool,
		setColor,
		pointerToFrame,
		beginStroke,
		moveStroke,
		endStroke,
		cancelDraft,
		getCropRect,
		applyCropDraft,
		resetCrop,
		undo,
		clear,
		replaceCapture,
		dispose,
	};
}

export type MarkSession = ReturnType<typeof createMarkSession>;
