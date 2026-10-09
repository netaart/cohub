import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardItem } from "@neta-art/cohub/board";
import { routeBoardEdits } from "../lib/board/core/document-edits.ts";
import { boardDocument } from "./board/fixtures.ts";

test("editing a displayed item never authors untouched playback values", () => {
	const base = boardDocument({ items: { box: { type: "shape" } } });
	const stored = base.items.box as BoardItem;
	const displayed = { ...stored, position: { x: 900, y: 700 }, opacity: 0.5 };
	const next = routeBoardEdits({
		base, evaluated: new Map(), displayed: new Map([["box", displayed]]),
		draft: new Map([["box", { ...displayed, style: { fill: "blue" } }]]), playhead: null, recording: false,
	});
	assert.deepEqual(next.items.box?.position, stored.position);
	assert.equal(next.items.box?.opacity, 1);
	assert.deepEqual(next.items.box?.style, { fill: "blue" });
	assert.equal(next.animations, base.animations);
	assert.deepEqual(base.items.box, stored);
});

test("only a user's transform delta is authored from a moving display", () => {
	const base = boardDocument({ items: { box: { type: "shape" } } });
	const stored = base.items.box as BoardItem;
	const displayed = { ...stored, position: { x: 900, y: 700 }, opacity: 0.5 };
	const next = routeBoardEdits({
		base, evaluated: new Map(), displayed: new Map([["box", displayed]]),
		draft: new Map([["box", { ...displayed, rotation: 45 }]]), playhead: null, recording: false,
	});
	assert.equal(next.items.box?.rotation, 45);
	assert.deepEqual(next.items.box?.position, stored.position);
	assert.equal(next.items.box?.opacity, 1);
});

for (const playhead of [null, { animationId: "motion", time: 500 }]) {
	test(`moving an animated value applies only the user delta (${playhead ? "playhead" : "playback"})`, () => {
		const base = boardDocument({ items: { box: { type: "shape", position: { x: 0, y: 20 }, scale: 2 } }, animations: {
			motion: { duration: 1000, tracks: { offset: { target: "box", property: "position", composite: "add", keyframes: [{ at: 0, value: { x: 100, y: 0 } }] } } },
		} });
		const displayed = { ...base.items.box, position: { x: 100, y: 20 }, scale: 4 } as BoardItem;
		const next = routeBoardEdits({
			base, evaluated: new Map([["box", displayed]]), displayed: new Map([["box", displayed]]),
			draft: new Map([["box", { ...displayed, position: { x: 110, y: 20 }, scale: 6 }]]), playhead, recording: false,
		});
		assert.deepEqual(next.items.box?.position, { x: 10, y: 20 });
		assert.equal(next.items.box?.scale, 3);
		assert.equal(next.animations, base.animations);
	});
}

test("recording does not overwrite an existing additive track with the generated id", () => {
	const base = boardDocument({ items: { box: { type: "shape" } }, animations: {
		motion: { duration: 1000, tracks: { "box-position": { target: "box", property: "position", composite: "add", keyframes: [{ at: 0, value: { x: 100, y: 0 } }] } } },
	} });
	const shown = { ...base.items.box, position: { x: 100, y: 0 } } as BoardItem;
	const next = routeBoardEdits({ base, evaluated: new Map([["box", shown]]), draft: new Map([["box", { ...shown, position: { x: 110, y: 0 } }]]), playhead: { animationId: "motion", time: 500 }, recording: true });
	assert.deepEqual(next.animations.motion?.tracks["box-position"], base.animations.motion?.tracks["box-position"]);
	assert.equal(Object.keys(next.animations.motion?.tracks ?? {}).length, 2);
});
