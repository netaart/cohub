import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardHistoryPage, BoardTransactionRecord } from "@cohub/protocol";
import {
	applyBoardEvaluation,
	boardAnimationTime,
	boardDocumentAt,
	boardEase,
	boardPresetTracks,
	buildBoardScene,
	compileBoardAnimations,
	createBoardReplayPlayer,
	evaluateBoardAnimations,
	resolveSceneArrow,
	type BoardArrowItem,
	type SceneItem,
} from "../src/board/index.js";
import { boardDocument } from "./board/fixtures.js";

const close = (actual: number, expected: number, epsilon = 1e-6) =>
	assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);

test("CSS easings match their definitions", () => {
	close(boardEase("linear")(0.3), 0.3);
	close(boardEase("ease-in-out")(0.5), 0.5, 1e-3);
	assert.ok(boardEase("ease-in")(0.25) < 0.25);
	assert.ok(boardEase("ease-out")(0.25) > 0.25);
	assert.equal(boardEase("steps(4, end)")(0.3), 0.25);
	assert.equal(boardEase("steps(4, start)")(0.3), 0.5);
	close(boardEase("cubic-bezier(0, 0, 1, 1)")(0.7), 0.7, 1e-4);
});

test("animation time holds before delay, loops, and resets or holds after the end", () => {
	const header = { duration: 1000, delay: 200, loop: false, end: "hold" as const, play: "manual" as const };
	assert.equal(boardAnimationTime(header, 100), 0);
	assert.equal(boardAnimationTime(header, 700), 500);
	assert.equal(boardAnimationTime(header, 5000), 1000);
	assert.equal(boardAnimationTime({ ...header, end: "reset" }, 5000), null);
	assert.equal(boardAnimationTime({ ...header, loop: true }, 1450), 250);
});

const lecture = boardDocument({
	items: {
		card: { type: "shape", position: { x: 100, y: 100 }, opacity: 0.8, style: { fill: "#000000" } },
		title: { type: "text", props: { text: "Relativity" } },
	},
	animations: {
		intro: {
			duration: 2000,
			tracks: {
				move: { target: "card", property: "position", keyframes: [{ at: 0, value: { x: 0, y: 0 } }, { at: 1000, value: { x: 200, y: 100 } }] },
				fade: { target: "card", property: "opacity", composite: "add", keyframes: [{ at: 0, value: 0 }, { at: 1000, value: 1 }] },
				tint: { target: "card", property: "style.fill", keyframes: [{ at: 0, value: "#000000" }, { at: 1000, value: "#ffffff" }] },
				type: { target: "title", property: "props.reveal", keyframes: [{ at: 500, value: 0 }, { at: 1500, value: 1 }] },
				zoom: { target: "camera", property: "zoom", keyframes: [{ at: 0, value: 1 }, { at: 2000, value: 2 }] },
			},
		},
	},
});

test("tracks drive JSON paths: vectors, colors, nested props and the camera", () => {
	const compiled = compileBoardAnimations(lecture);
	const result = evaluateBoardAnimations(compiled, { intro: 500 });
	const card = result.items.get("card");
	assert.deepEqual(card?.position, { x: 100, y: 50 });
	// `add` on opacity multiplies the base value.
	close(card?.opacity ?? 0, 0.4);
	assert.equal(card?.style.fill, "#808080");
	// Before its first keyframe a track holds its first value.
	assert.equal((result.items.get("title") as { props: { reveal: number } }).props.reveal, 0);
	close(result.camera.zoom ?? 0, 1.25);
	// The document itself is untouched.
	assert.deepEqual(lecture.items.card?.position, { x: 100, y: 100 });
	const at = applyBoardEvaluation(lecture, result);
	assert.deepEqual(at.items.card?.position, { x: 100, y: 50 });
});

test("animations absent from the times contribute nothing", () => {
	const result = evaluateBoardAnimations(compileBoardAnimations(lecture), {});
	assert.equal(result.items.size, 0);
	assert.deepEqual(result.camera, {});
});

test("of several replace tracks the latest started wins; sub-paths refine whole values", () => {
	const document = boardDocument({
		items: { dot: { type: "shape" } },
		animations: {
			a: {
				duration: 3000,
				tracks: {
					early: { target: "dot", property: "position", keyframes: [{ at: 0, value: { x: 1, y: 1 } }] },
					late: { target: "dot", property: "position", keyframes: [{ at: 1000, value: { x: 2, y: 2 } }] },
				},
			},
		},
	});
	const compiled = compileBoardAnimations(document);
	assert.deepEqual(evaluateBoardAnimations(compiled, { a: 500 }).items.get("dot")?.position, { x: 1, y: 1 });
	assert.deepEqual(evaluateBoardAnimations(compiled, { a: 1500 }).items.get("dot")?.position, { x: 2, y: 2 });
	// A `position.x` track applies after `position`, adding to the winner.
	const withNudge = compileBoardAnimations(boardDocument({
		items: { dot: { type: "shape" } },
		animations: { a: { duration: 10, tracks: {
			base: { target: "dot", property: "position", keyframes: [{ at: 0, value: { x: 5, y: 5 } }] },
			nudge: { target: "dot", property: "position.x", composite: "add", keyframes: [{ at: 0, value: 10 }] },
		} } },
	}));
	assert.deepEqual(evaluateBoardAnimations(withNudge, { a: 0 }).items.get("dot")?.position, { x: 15, y: 5 });
});

test("nested animations take their time from the parent's time track", () => {
	const document = boardDocument({
		items: { dot: { type: "shape" } },
		animations: {
			child: { duration: 1000, tracks: { x: { target: "dot", property: "position.x", keyframes: [{ at: 0, value: 0 }, { at: 1000, value: 100 }] } } },
			// Plays the child backwards at double speed.
			parent: { duration: 500, tracks: { remap: { target: "child", property: "time", keyframes: [{ at: 0, value: 1000 }, { at: 500, value: 0 }] } } },
		},
	});
	const result = evaluateBoardAnimations(compileBoardAnimations(document), { parent: 125 });
	assert.equal(result.times.get("child"), 750);
	close(result.items.get("dot")?.position.x ?? 0, 75);
});

test("spline position tracks pass through keyframes and orient the item", () => {
	const document = boardDocument({
		items: { ship: { type: "shape", rotation: 5 } },
		animations: {
			fly: {
				duration: 2000,
				tracks: {
					path: {
						target: "ship",
						property: "position",
						interpolation: "spline",
						orient: true,
						keyframes: [{ at: 0, value: { x: 0, y: 0 } }, { at: 1000, value: { x: 100, y: 0 } }, { at: 2000, value: { x: 100, y: 100 } }],
					},
				},
			},
		},
	});
	const compiled = compileBoardAnimations(document);
	assert.deepEqual(evaluateBoardAnimations(compiled, { fly: 1000 }).items.get("ship")?.position, { x: 100, y: 0 });
	const early = evaluateBoardAnimations(compiled, { fly: 200 }).items.get("ship");
	// Heading east, give or take the curve's bow, on top of the item's own 5°.
	close(early?.rotation ?? 0, 5, 15);
	const late = evaluateBoardAnimations(compiled, { fly: 1800 }).items.get("ship");
	assert.ok((late?.rotation ?? 0) > 60, "turns down the second leg");
});

test("boardDocumentAt renders one moment with ambient animations joined in", () => {
	const document = boardDocument({
		items: { dot: { type: "shape" } },
		animations: {
			ambient: { duration: 1000, play: "always", tracks: { spin: { target: "dot", property: "rotation", keyframes: [{ at: 0, value: 0 }, { at: 1000, value: 360 }] } } },
		},
	});
	close(boardDocumentAt(document, null, 1250).document.items.dot?.rotation ?? 0, 90);
});

test("presets expand into plain tracks keyed per target", () => {
	const tracks = boardPresetTracks("rise", { targets: ["a", "b"], at: 100, stagger: 50 });
	assert.deepEqual(Object.keys(tracks).sort(), ["a-rise-opacity", "a-rise-y", "b-rise-opacity", "b-rise-y"]);
	assert.equal(tracks["b-rise-y"]?.keyframes[0]?.at, 150);
	assert.equal(tracks["a-rise-y"]?.composite, "add");
	const document = boardDocument({
		items: { a: { type: "shape", position: { x: 0, y: 10 } }, b: { type: "shape" } },
		animations: { enter: { duration: 1000, tracks } },
	});
	const done = evaluateBoardAnimations(compileBoardAnimations(document), { enter: 1000 }).items.get("a");
	assert.deepEqual(done?.position, { x: 0, y: 10 });
	close(done?.opacity ?? 0, 1);
});

test("the scene resolves hierarchy and reuses unchanged items", () => {
	const document = boardDocument({
		items: {
			slide: { type: "frame", position: { x: 1000, y: 0 }, size: { width: 400, height: 300 }, rotation: 0 },
			label: { type: "shape", parent: "slide", position: { x: 20, y: 30 }, size: { width: 100, height: 50 } },
			other: { type: "shape", position: { x: 0, y: 0 } },
		},
	});
	const scene = buildBoardScene(document);
	// Paint order: roots by z (insertion order by default), each subtree after its parent.
	assert.deepEqual(scene.items.map((item) => item.id), ["slide", "label", "other"]);
	const label = scene.get("label");
	assert.equal(label?.frame.x, 1020);
	assert.equal(label?.frame.y, 30);
	assert.deepEqual(scene.descendants("slide"), ["label"]);

	const moved = { ...document, items: { ...document.items, other: { ...(document.items.other as object), position: { x: 5, y: 5 } } } } as typeof document;
	const next = buildBoardScene(moved, scene);
	assert.equal(next.get("label"), label, "unchanged subtree is reused");
	assert.notEqual(next.get("other"), scene.get("other"));
});

test("bound arrows follow the items they join", () => {
	const document = boardDocument({
		items: {
			a: { type: "shape", position: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
			b: { type: "shape", position: { x: 400, y: 0 }, size: { width: 100, height: 100 } },
			link: { type: "arrow", props: { start: { item: "a" }, end: { item: "b" } } },
		},
	});
	const scene = buildBoardScene(document);
	const resolved = resolveSceneArrow(scene.get("link") as SceneItem<BoardArrowItem>, scene);
	assert.ok(resolved.start.point.x >= 100 && resolved.start.point.x < 110, "leaves a's right edge");
	assert.ok(resolved.end.point.x <= 400 && resolved.end.point.x > 390, "reaches b's left edge");
	close(resolved.start.point.y, 50);
	assert.equal(resolved.start.item, "a");
});

test("replay steps through before/after deltas in both directions", () => {
	const v1 = boardDocument({ items: { a: { type: "shape" } } });
	const record = (version: number, before: BoardTransactionRecord["before"], after: BoardTransactionRecord["after"]): BoardTransactionRecord => ({
		id: `tx-${version}`,
		mutationId: `m-${version}`,
		baseVersion: version - 1,
		version,
		actorId: "alice",
		clientId: null,
		source: null,
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, version)).toISOString(),
		before,
		after,
	});
	const a = v1.items.a as NonNullable<typeof v1.items.a>;
	const moved = { ...a, position: { x: 50, y: 0 } };
	const b = boardDocument({ items: { b: { type: "text", props: { text: "B" } } } }).items.b as NonNullable<typeof v1.items.a>;
	const live = { ...v1, items: { a: moved, b } };
	const page: BoardHistoryPage = {
		version: 3,
		nextBefore: null,
		transactions: [
			record(3, { items: { b: null } }, { items: { b } }),
			record(2, { items: { a } }, { items: { a: moved } }),
		],
	};
	const player = createBoardReplayPlayer(live, page);
	assert.equal(player.floor, 1);
	assert.deepEqual(Object.keys(player.documentAt(1).items), ["a"]);
	assert.deepEqual(player.documentAt(1).items.a?.position, { x: 0, y: 0 });
	assert.deepEqual(player.documentAt(2).items.a?.position, { x: 50, y: 0 });
	assert.deepEqual(Object.keys(player.documentAt(3).items).sort(), ["a", "b"]);
	assert.deepEqual(player.changedItemIds(3), ["b"]);
	assert.equal(player.entries.length, 2);
});
