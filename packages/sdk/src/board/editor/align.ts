/**
 * Align / distribute — pure geometry over frames.
 * Returns a frame patch map; the editor applies it and refreshes bound arrows.
 */

import type { BoardFrame } from "../model/index.js";
import { itemBounds, type Rect, selectionBounds } from "../model/index.js";

export type AlignMode =
	| "left"
	| "center-x"
	| "right"
	| "top"
	| "center-y"
	| "bottom";

export type DistributeAxis = "horizontal" | "vertical";

export function alignFrames(
	frames: Map<string, BoardFrame>,
	mode: AlignMode,
): Map<string, BoardFrame> {
	if (frames.size < 2) return new Map();
	const bounds = selectionBounds([...frames.values()]);
	if (!bounds) return new Map();

	const next = new Map<string, BoardFrame>();
	for (const [id, frame] of frames) {
		const box = itemBounds(frame);
		let x = frame.x;
		let y = frame.y;
		switch (mode) {
			case "left":
				x = frame.x + (bounds.x - box.x);
				break;
			case "center-x":
				x = frame.x + (bounds.x + bounds.width / 2 - (box.x + box.width / 2));
				break;
			case "right":
				x = frame.x + (bounds.x + bounds.width - (box.x + box.width));
				break;
			case "top":
				y = frame.y + (bounds.y - box.y);
				break;
			case "center-y":
				y = frame.y + (bounds.y + bounds.height / 2 - (box.y + box.height / 2));
				break;
			case "bottom":
				y = frame.y + (bounds.y + bounds.height - (box.y + box.height));
				break;
		}
		if (x !== frame.x || y !== frame.y) next.set(id, { ...frame, x, y });
	}
	return next;
}

export function distributeFrames(
	frames: Map<string, BoardFrame>,
	axis: DistributeAxis,
): Map<string, BoardFrame> {
	if (frames.size < 3) return new Map();

	const entries = [...frames.entries()].map(([id, frame]) => ({
		id,
		frame,
		box: itemBounds(frame),
	}));
	const horizontal = axis === "horizontal";
	entries.sort((a, b) => (horizontal ? a.box.x - b.box.x : a.box.y - b.box.y));

	const first = entries[0];
	const last = entries[entries.length - 1];
	if (!first || !last) return new Map();

	const start = horizontal ? first.box.x : first.box.y;
	const end = horizontal
		? last.box.x + last.box.width
		: last.box.y + last.box.height;
	const totalSize = entries.reduce(
		(sum, entry) => sum + (horizontal ? entry.box.width : entry.box.height),
		0,
	);
	const gap = (end - start - totalSize) / (entries.length - 1);

	const next = new Map<string, BoardFrame>();
	let cursor = start;
	for (const entry of entries) {
		const size = horizontal ? entry.box.width : entry.box.height;
		const delta = cursor - (horizontal ? entry.box.x : entry.box.y);
		if (delta !== 0) {
			next.set(entry.id, {
				...entry.frame,
				x: horizontal ? entry.frame.x + delta : entry.frame.x,
				y: horizontal ? entry.frame.y : entry.frame.y + delta,
			});
		}
		cursor += size + gap;
	}
	return next;
}

export function framesBounds(frames: Iterable<BoardFrame>): Rect | null {
	return selectionBounds([...frames]);
}
