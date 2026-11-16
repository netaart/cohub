import type { BoardFrame } from "@cohub/protocol";
import { Container, type Renderer } from "pixi.js";
import type { BoardDepthSurface, BoardDepthView } from "../../model/depth.js";
import { type BoardDepthBend, compileBoardDepthBend, isBoardDepthBendSource, prepareBoardDepthBend } from "./bend.js";
import type { BoardDepthPicture } from "./capture.js";

const DENSITY_STEPS = 4;

export function boardDepthDensity(view: BoardDepthView, resolution: number, surface: BoardDepthSurface): number {
	const steps = Math.round(Math.log2(Math.max(view.zoom * resolution * surface.scale, 1e-3)) * DENSITY_STEPS);
	return 2 ** (steps / DENSITY_STEPS);
}

export function resolveBoardDepthBend(renderer: Renderer, id: string, source: unknown, fault: (id: string, message: string) => void): BoardDepthBend | null {
	if (source === undefined) return null;
	if (!isBoardDepthBendSource(source)) {
		fault(id, "depth.bend.kind is custom, but the item's script module exports no bend = { glsl }.");
		return null;
	}
	try {
		const bend = prepareBoardDepthBend(source);
		const error = compileBoardDepthBend(renderer, bend, `${id} bend`);
		if (error) throw new Error(error);
		return bend;
	} catch (error) {
		fault(id, error instanceof Error ? error.message : String(error));
		return null;
	}
}

export function drawBoardDepthParts(renderer: Renderer, picture: BoardDepthPicture, parts: readonly Container[], frame: BoardFrame, density: number, maxEdge?: number) {
	const holder = new Container({ isRenderGroup: true });
	const homes = parts.map((part) => ({ part, parent: part.parent, index: part.parent?.getChildIndex(part) ?? 0 }));
	for (const { part } of homes) holder.addChild(part);
	try {
		picture.draw(renderer, holder, frame, density, maxEdge);
	} finally {
		for (const { part, parent, index } of homes) parent?.addChildAt(part, Math.min(index, parent.children.length));
		holder.destroy();
	}
}
