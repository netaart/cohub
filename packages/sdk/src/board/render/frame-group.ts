
import { Container, Graphics } from "pixi.js";
import type { BoardScene, BoardSceneItem } from "../model/scene.js";
import { framePoint } from "@cohub/protocol";
import { type BoardEffectsContext, hasBoardEffects, rescaleBoardEffects, syncBoardEffects } from "./effects.js";

export function isClippingFrame(item: BoardSceneItem): boolean {
	return item.type === "frame" && (item.props as { clip?: boolean }).clip !== false;
}

export function isGroupingFrame(item: BoardSceneItem): boolean {
	return item.type === "frame" && (isClippingFrame(item) || isSelfGroupedFrame(item));
}

export function isSelfGroupedFrame(item: BoardSceneItem): boolean {
	return item.type === "frame" && (hasBoardEffects(item.style) || item.script?.enabled === true);
}

export function groupingAncestor(scene: BoardScene, item: BoardSceneItem): string | undefined {
	let cursor = item.parent;
	for (let depth = 0; cursor && depth < 64; depth += 1) {
		const parent = scene.get(cursor);
		if (!parent) return undefined;
		if (isGroupingFrame(parent)) return cursor;
		cursor = parent.parent;
	}
	return undefined;
}

export function traceFrameOutline(graphics: Graphics, item: BoardSceneItem) {
	const corners = [framePoint(item.frame, 0, 0), framePoint(item.frame, 1, 0), framePoint(item.frame, 1, 1), framePoint(item.frame, 0, 1)];
	graphics.poly(corners.flatMap((point) => [point.x, point.y])).fill(0xffffff);
}

export type FrameGroup = { group: Container; content: Container; mask: Graphics | null; sig: string };

export function syncFrameGroup(entry: FrameGroup | undefined, item: BoardSceneItem, context: BoardEffectsContext): FrameGroup {
	const next = entry ?? (() => {
		const group = new Container({ label: `board-frame-${item.id}`, sortableChildren: true });
		const content = group.addChild(new Container({ sortableChildren: true }));
		return { group, content, mask: null, sig: "" };
	})();
	const clips = isClippingFrame(item);
	if (clips && !next.mask) {
		next.mask = next.content.addChild(new Graphics());
		next.content.mask = next.mask;
		next.sig = "";
	} else if (!clips && next.mask) {
		next.content.mask = null;
		next.mask.destroy();
		next.mask = null;
	}
	const { x, y, width, height, rotation } = item.frame;
	const sig = `${x},${y},${width},${height},${rotation}`;
	if (next.mask && sig !== next.sig) {
		next.sig = sig;
		traceFrameOutline(next.mask.clear(), item);
	}
	syncBoardEffects(next.group, item.style, context);
	return next;
}

export function syncBoardItemEffects(container: Container, item: BoardSceneItem, context: BoardEffectsContext) {
	syncBoardEffects(container, item.type === "frame" ? undefined : item.style, context);
}

export function rescaleBoardItemEffects(container: Container, item: BoardSceneItem, context: BoardEffectsContext) {
	if (item.type !== "frame") rescaleBoardEffects(container, item.style, context);
}
