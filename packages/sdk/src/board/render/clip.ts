
import { Container, Graphics } from "pixi.js";
import type { BoardScene, BoardSceneItem } from "../model/scene.js";
import { framePoint } from "@cohub/protocol";

export function isClippingFrame(item: BoardSceneItem): boolean {
	return item.type === "frame" && (item.props as { clip?: boolean }).clip !== false;
}

export function clippingAncestor(scene: BoardScene, item: BoardSceneItem): string | undefined {
	let cursor = item.parent;
	for (let depth = 0; cursor && depth < 64; depth += 1) {
		const parent = scene.get(cursor);
		if (!parent) return undefined;
		if (isClippingFrame(parent)) return cursor;
		cursor = parent.parent;
	}
	return undefined;
}

export function traceFrameOutline(graphics: Graphics, item: BoardSceneItem) {
	const corners = [framePoint(item.frame, 0, 0), framePoint(item.frame, 1, 0), framePoint(item.frame, 1, 1), framePoint(item.frame, 0, 1)];
	graphics.poly(corners.flatMap((point) => [point.x, point.y])).fill(0xffffff);
}

export type ClipGroup = { group: Container; mask: Graphics; sig: string };

export function syncClipGroup(entry: ClipGroup | undefined, item: BoardSceneItem): ClipGroup {
	const next = entry ?? (() => {
		const group = new Container({ label: `board-clip-${item.id}` });
		const mask = new Graphics();
		group.addChild(mask);
		group.mask = mask;
		return { group, mask, sig: "" };
	})();
	const { x, y, width, height, rotation } = item.frame;
	const sig = `${x},${y},${width},${height},${rotation}`;
	if (sig !== next.sig) {
		next.sig = sig;
		next.mask.clear();
		traceFrameOutline(next.mask, item);
	}
	return next;
}
