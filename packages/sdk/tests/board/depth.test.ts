import assert from "node:assert/strict";
import { test } from "node:test";
import { type BoardDepthView, boardDepthItemOutline, boardDepthOf, boardDepthPose, boardDepthRootOf, boardDepthRoots, boardDepthScreenPoint, boardDepthSurface, hitBoardDepthSurface } from "../../src/board/model/depth.js";
import { planBoardExport } from "../../src/board/model/export-plan.js";
import { pointToWorld, screenPoint } from "../../src/board/model/geometry.js";
import { boardProjection, boardViewRect, boardViewToWorld, panBoardView, zoomBoardView } from "../../src/board/model/view-camera.js";
import { boardScene } from "./fixtures.js";

const VIEW: BoardDepthView = { x: 100, y: 50, zoom: 1.5, width: 1200, height: 800 };
const TIPPED: BoardDepthView = { ...VIEW, pitch: 50, bearing: 35 };
const card = (depth: Record<string, unknown>) => ({ type: "shape", position: { x: 120, y: 80 }, size: { width: 300, height: 200 }, depth });

test("rays find the point they show, through lift, tilt, spin and bends, at any pitch and bearing", () => {
	for (const view of [VIEW, TIPPED]) {
		const projection = boardProjection(view, view);
		for (const depth of [{ lift: 120, tilt: { x: 25, y: -40 }, spin: 33 }, { lift: 40, bend: { kind: "cloth", amount: 0.4, phase: 1 } }, { tilt: { y: 60 }, bend: { kind: "curl", amount: 0.3 } }]) {
			const item = boardScene({ a: { ...card(depth), rotation: 15 } }).get("a");
			const resolved = item && boardDepthOf(item);
			assert.ok(item && resolved);
			const surface = boardDepthSurface({ frame: item.frame, origin: item.origin, depth: resolved });
			const pose = boardDepthPose(surface, projection);
			for (const [u, v] of [[0.5, 0.5], [0.2, 0.7], [0.8, 0.25]] as const) {
				const screen = boardDepthScreenPoint(surface, pose, projection, u, v);
				const hit = hitBoardDepthSurface(surface, pose, projection, screen);
				assert.ok(hit);
				const seen = boardDepthScreenPoint(surface, pose, projection, hit.u, hit.v);
				assert.ok(Math.hypot(seen.x - screen.x, seen.y - screen.y) < 0.5);
			}
		}
	}
});

test("a tipped and turned camera keeps the Board under the pointer as it pans and zooms", () => {
	const level = boardProjection(VIEW, VIEW);
	const corner = screenPoint(37, 611);
	assert.deepEqual(level.ground(corner), pointToWorld(corner, VIEW));
	const projection = boardProjection(TIPPED, TIPPED);
	const point = projection.ground(corner);
	const back = projection.project(point.x, point.y);
	assert.ok(Math.hypot(back.x - corner.x, back.y - corner.y) < 1e-6);
	const middle = projection.ground(screenPoint(600, 400));
	assert.ok(Math.abs(middle.x - (600 - VIEW.x) / VIEW.zoom) < 1e-9 && Math.abs(middle.y - (400 - VIEW.y) / VIEW.zoom) < 1e-9);
	const to = screenPoint(300, 200);
	const panned = panBoardView(TIPPED, TIPPED, corner, to);
	const held = boardViewToWorld(panned, TIPPED, to);
	assert.ok(Math.hypot(held.x - point.x, held.y - point.y) < 1e-6);
	const zoomed = zoomBoardView(TIPPED, TIPPED, corner, 3);
	const kept = boardViewToWorld(zoomed, TIPPED, corner);
	assert.equal(zoomed.zoom, 3);
	assert.ok(Math.hypot(kept.x - point.x, kept.y - point.y) < 1e-6);
	const seen = boardViewRect(TIPPED, TIPPED);
	assert.ok(point.x >= seen.x && point.x <= seen.x + seen.width && point.y >= seen.y && point.y <= seen.y + seen.height);
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
