import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createArrowBoardItem,
	createDrawBoardItem,
	createShapeBoardItem,
	createTextBoardItem,
	defaultBoardRegistry as registry,
	layoutBoardText,
	mediaFrameSize,
	worldPoint,
} from "../../src/board/model/index.js";
import { materializeClipboard, remapItems } from "../../src/board/editor/clipboard.js";
import { diffBoardEdits, routeBoardEdits } from "../../src/board/editor/document-edits.js";
import { computeSnap } from "../../src/board/editor/snapping.js";
import { boardDocument, sceneItem } from "./fixtures.js";

// ─── Snapping ───────────────────────────────────────────────────────

test("computeSnap snaps a near-aligned edge and emits a guide", () => {
	const result = computeSnap({ x: 102, y: 0, width: 50, height: 50 }, [{ x: 0, y: 0, width: 100, height: 50 }], { threshold: 8 });
	assert.equal(result.dx, -2);
	assert.ok(result.guides.some((guide) => guide.axis === "x" && guide.at === 100));
});

test("computeSnap leaves far rects alone and snaps to the grid", () => {
	const far = computeSnap({ x: 200, y: 0, width: 50, height: 50 }, [{ x: 0, y: 0, width: 100, height: 50 }], { threshold: 8 });
	assert.deepEqual([far.dx, far.dy], [0, 0]);
	assert.equal(computeSnap({ x: 33, y: 0, width: 10, height: 10 }, [], { threshold: 8, gridSize: 32 }).dx, -1);
});

// ─── Shape definitions ──────────────────────────────────────────────

test("an ellipse hits its center and misses its corners", () => {
	const ellipse = sceneItem("e", { type: "shape", size: { width: 100, height: 100 }, props: { geometry: "ellipse" } });
	assert.equal(registry.hitTest(ellipse, worldPoint(50, 50)), true);
	assert.equal(registry.hitTest(ellipse, worldPoint(2, 2)), false);
});

test("a stroke hits near its ink only", () => {
	const draw = sceneItem("d", { type: "draw", style: { strokeWidth: 4 }, props: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] } });
	assert.equal(registry.hitTest(draw, worldPoint(50, 1)), true);
	assert.equal(registry.hitTest(draw, worldPoint(50, 60)), false);
});

test("content-scaling items lock their aspect; containers do not", () => {
	const locked = (item: Record<string, unknown>) => registry.capabilities(sceneItem("x", item)).aspectLocked;
	assert.equal(locked({ type: "text", props: { text: "Hi" } }), true);
	assert.equal(locked({ type: "image", size: { width: 10, height: 10 }, props: { src: "a.png" } }), true);
	assert.equal(locked({ type: "draw", props: { points: [{ x: 0, y: 0 }] } }), true);
	assert.equal(locked({ type: "shape" }), false);
	assert.equal(locked({ type: "frame" }), false);
	assert.equal(registry.capabilities(sceneItem("t", { type: "text", props: { text: "" } })).canEdit, true);
});

// ─── Factories ──────────────────────────────────────────────────────

test("factories write only what differs from the schema defaults", () => {
	const text = createTextBoardItem("Hello", 10, 20, "neutral", "t").item;
	assert.deepEqual(text.position, { x: 10, y: 20 });
	assert.deepEqual(text.style, {});
	const shape = createShapeBoardItem("diamond", 0, 0, "rose", "s").item;
	assert.equal(shape.type === "shape" && shape.props.geometry, "diamond");
	assert.equal(shape.style.stroke, "rose");
});

test("a text item is as large as its measured layout", () => {
	const item = sceneItem("t", createTextBoardItem("Hello", 0, 0).item as never);
	const layout = layoutBoardText(item.props as never);
	assert.equal(item.frame.width, layout.width);
	assert.equal(item.frame.height, layout.height);
});

test("strokes and arrows store their points relative to their position", () => {
	const draw = createDrawBoardItem([{ x: 10, y: 20, p: 0.5 }, { x: 30, y: 60, p: 0.5 }], "brand").item;
	assert.deepEqual(draw.position, { x: 10, y: 20 });
	assert.deepEqual(draw.type === "draw" && draw.props.points.at(-1), { x: 20, y: 40, p: 0.5 });
	const arrow = createArrowBoardItem({ x: 100, y: 100 }, { x: 150, y: 80 }, "brand").item;
	assert.deepEqual(arrow.position, { x: 100, y: 100 });
	assert.deepEqual(arrow.type === "arrow" && arrow.props.end, { x: 50, y: -20 });
	const bound = createArrowBoardItem({ x: 0, y: 0 }, { item: "target" }, "brand").item;
	assert.deepEqual(bound.type === "arrow" && bound.props.end, { item: "target", anchor: "auto" });
});

test("mediaFrameSize keeps the natural aspect and falls back when unknown", () => {
	assert.deepEqual(mediaFrameSize(1920, 1080, 480), { width: 480, height: 270 });
	assert.deepEqual(mediaFrameSize(null, null, 480, { width: 320, height: 180 }), { width: 320, height: 180 });
});

// ─── Clipboard ──────────────────────────────────────────────────────

test("remapping keeps internal parents and bindings and releases the rest", () => {
	const document = boardDocument({
		items: {
			frame: { type: "frame", size: { width: 400, height: 300 } },
			card: { type: "shape", parent: "frame", position: { x: 10, y: 10 } },
			outside: { type: "shape", position: { x: 600, y: 0 } },
			link: { type: "arrow", props: { start: { item: "card" }, end: { item: "outside" } } },
		},
	});
	const { outside: _outside, ...copied } = document.items;
	const idMap = new Map(Object.keys(copied).map((id) => [id, `${id}-copy`]));
	const result = remapItems(copied, idMap, undefined, () => ({ x: 7, y: 8 }));
	assert.equal(result["card-copy"]?.parent, "frame-copy");
	const link = result["link-copy"];
	assert.ok(link?.type === "arrow");
	assert.deepEqual(link.props.start, { item: "card-copy", anchor: "auto" });
	assert.deepEqual(link.props.end, { x: 7, y: 8 });
});

test("pasting shifts roots only, so children keep their frame offsets", () => {
	const document = boardDocument({
		items: {
			frame: { type: "frame", position: { x: 100, y: 100 } },
			card: { type: "shape", parent: "frame", position: { x: 10, y: 10 } },
		},
	});
	const pasted = Object.values(materializeClipboard({ kind: "cohub.board.clipboard", version: 3, items: document.items, origin: { x: 0, y: 0 } } as never, { x: 50, y: 0 }));
	assert.deepEqual(pasted.find((item) => item.type === "frame")?.position, { x: 150, y: 100 });
	assert.deepEqual(pasted.find((item) => item.type === "shape")?.position, { x: 10, y: 10 });
});

// ─── Document edits ─────────────────────────────────────────────────

const animated = () =>
	boardDocument({
		items: { box: { type: "shape", position: { x: 0, y: 0 } } },
		animations: {
			intro: {
				duration: 1000,
				tracks: { move: { target: "box", property: "position", keyframes: [{ at: 0, value: { x: 0, y: 0 } }, { at: 1000, value: { x: 100, y: 0 } }] } },
			},
		},
	});

test("without a playhead, the draft is the new item", () => {
	const base = animated();
	const moved = { ...base.items.box, position: { x: 40, y: 40 } } as never;
	const next = routeBoardEdits({ base, evaluated: new Map(), draft: new Map([["box", moved]]), playhead: null, recording: false });
	assert.deepEqual(next.items.box?.position, { x: 40, y: 40 });
	assert.equal(next.animations, base.animations);
});

test("at the playhead, animated properties become keyframes and the rest edit the item", () => {
	const base = animated();
	const shown = { ...base.items.box, position: { x: 50, y: 0 } } as never;
	const edited = { ...base.items.box, position: { x: 50, y: 30 }, opacity: 0.5 } as never;
	const next = routeBoardEdits({ base, evaluated: new Map([["box", shown]]), draft: new Map([["box", edited]]), playhead: { animationId: "intro", time: 500 }, recording: false });
	assert.deepEqual(next.items.box?.position, { x: 0, y: 0 });
	assert.equal(next.items.box?.opacity, 0.5);
	assert.deepEqual(next.animations.intro?.tracks.move?.keyframes.map((entry) => entry.at), [0, 500, 1000]);
});

test("recording keyframes a property that had no track, from its stored value", () => {
	const base = animated();
	const edited = { ...base.items.box, rotation: 45 } as never;
	const next = routeBoardEdits({ base, evaluated: new Map(), draft: new Map([["box", edited]]), playhead: { animationId: "intro", time: 1500 }, recording: true });
	assert.equal(next.items.box?.rotation, 0);
	const track = next.animations.intro?.tracks["box-rotation"];
	assert.deepEqual(track?.keyframes, [{ at: 0, value: 0 }, { at: 1500, value: 45 }]);
	assert.equal(next.animations.intro?.duration, 1500);
});

test("diffs are minimal merge patches that round-trip creation and deletion", () => {
	const base = animated();
	const moved = { ...base, items: { ...base.items, box: { ...base.items.box, position: { x: 5, y: 0 } } as never } };
	assert.deepEqual(diffBoardEdits(base, moved, ["box"]), { items: { box: { position: { x: 5 } } } });
	const removed = { ...base, items: {} };
	assert.deepEqual(diffBoardEdits(base, removed, ["box"]), { items: { box: null } });
	const restored = diffBoardEdits(removed, base, ["box"]);
	assert.equal(restored.items?.box && "type" in restored.items.box && restored.items.box.type, "shape");
});
