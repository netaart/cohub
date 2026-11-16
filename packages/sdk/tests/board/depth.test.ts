import assert from "node:assert/strict";
import { test } from "node:test";
import { type BoardDepthView, boardDepthItemOutline, boardDepthOf, boardDepthRootOf, boardDepthRoots, boardDepthScreenPoint, boardDepthSurface, hitBoardDepthSurface } from "../../src/board/model/depth.js";
import { planBoardExport } from "../../src/board/model/export-plan.js";
import { boardScene } from "./fixtures.js";

const VIEW: BoardDepthView = { x: 100, y: 50, zoom: 1.5, width: 1200, height: 800 };
const card = (depth: Record<string, unknown>) => ({ type: "shape", position: { x: 120, y: 80 }, size: { width: 300, height: 200 }, depth });

test("rays find the point they show, through lift, tilt, spin and bends", () => {
	for (const depth of [{ lift: 120, tilt: { x: 25, y: -40 }, spin: 33 }, { lift: 40, bend: { kind: "cloth", amount: 0.4, phase: 1 } }, { tilt: { y: 60 }, bend: { kind: "curl", amount: 0.3 } }]) {
		const item = boardScene({ a: { ...card(depth), rotation: 15 } }).get("a");
		const resolved = item && boardDepthOf(item);
		assert.ok(item && resolved);
		const surface = boardDepthSurface({ frame: item.frame, origin: item.origin, depth: resolved }, VIEW);
		for (const [u, v] of [[0.5, 0.5], [0.2, 0.7], [0.8, 0.25]] as const) {
			const screen = boardDepthScreenPoint(surface, u, v);
			const hit = hitBoardDepthSurface(surface, screen);
			assert.ok(hit);
			const seen = boardDepthScreenPoint(surface, hit.u, hit.v);
			assert.ok(Math.hypot(seen.x - screen.x, seen.y - screen.y) < 0.5);
		}
	}
});

test("depth inside a lifted frame stays part of its picture", () => {
	const scene = boardScene({
		f: { type: "frame", size: { width: 400, height: 300 }, depth: { lift: 50 } },
		inner: { type: "shape", parent: "f", position: { x: 40, y: 40 }, size: { width: 100, height: 60 }, depth: { tilt: { x: 30 } } },
		alone: card({ spin: 20 }),
		flat: card({}),
	});
	assert.deepEqual(boardDepthRoots(scene).map((item) => item.id), ["f", "alone"]);
	assert.equal(boardDepthRootOf(scene, "inner"), "f");
	assert.equal(boardDepthItemOutline(scene, "flat", VIEW), null);
});

test("exports frame lifted items where they appear", () => {
	const alone = boardScene({ a: card({ lift: 300 }) });
	const fit = planBoardExport({ scene: alone, region: { kind: "all" }, scale: 1, padding: 0 });
	assert.ok(fit);
	const seen = boardDepthItemOutline(alone, "a", { x: -fit.world.x, y: -fit.world.y, zoom: 1, width: fit.world.width, height: fit.world.height });
	const { x, y, width, height } = fit.world;
	assert.ok(seen?.every((point) => point.x >= x - 1 && point.x <= x + width + 1 && point.y >= y - 1 && point.y <= y + height + 1));
	const reach = boardScene({ bar: { type: "shape", position: { x: 110, y: -150 }, size: { width: 100, height: 400 }, depth: { spin: 90 } } });
	assert.deepEqual(planBoardExport({ scene: reach, region: { kind: "rect", rect: { x: 0, y: 0, width: 100, height: 100 } }, scale: 1 })?.items.map((item) => item.id), ["bar"]);
});
