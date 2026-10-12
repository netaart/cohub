import assert from "node:assert/strict";
import { test } from "node:test";
import { compileBoardAnimations, evaluateBoardAnimations } from "../../src/board/model/animation.js";
import { boardDocument } from "./fixtures.js";

const timeTrack = (target: string, value: number) => ({ target, property: "time", keyframes: [{ at: 0, value }] });

test("shared animation descendants are sampled once per edge, not once per path", () => {
	const animations = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`a${i}`, {
		duration: 100,
		tracks: i < 16 ? Object.fromEntries(["x", "y", "z"].map((id) => [id, timeTrack(`a${i + 1}`, 100)])) : {
			turn: { target: "box", property: "rotation", keyframes: [{ at: 0, value: 0 }, { at: 100, value: 90 }] },
		},
	}]));
	const compiled = compileBoardAnimations(boardDocument({ items: { box: { type: "shape" } }, animations }));
	let reads = 0;
	for (const animation of compiled.animations.values()) {
		for (const track of animation.children) {
			track.values = new Proxy(track.values, { get(values, property, receiver) {
				if (property === "0") {
					reads += 1;
					assert.ok(reads <= 48, "Repeated expansion of a shared descendant");
				}
				return Reflect.get(values, property, receiver);
			} });
		}
	}
	const frame = evaluateBoardAnimations(compiled, { a0: 0 });
	assert.equal(frame.times.size, 17);
	assert.equal(frame.items.get("box")?.rotation, 90);
	assert.equal(reads, 48);
	assert.equal(new Set(compiled.order).size, 17);
});

test("nested clocks wait for all parents, including longer incoming paths", () => {
	const identityTime = (target: string) => ({ target, property: "time", keyframes: [{ at: 0, value: 0 }, { at: 100, value: 100 }] });
	const compiled = compileBoardAnimations(boardDocument({ items: { box: { type: "shape" } }, animations: {
		d: { duration: 100, tracks: { turn: { target: "box", property: "rotation", keyframes: [{ at: 0, value: 0 }, { at: 100, value: 100 }] } } },
		c: { duration: 100, tracks: { child: identityTime("d") } },
		a: { duration: 100, tracks: { direct: timeTrack("c", 10), indirect: timeTrack("b", 20) } },
		b: { duration: 100, tracks: { child: identityTime("c") } },
	} }));
	assert.equal(evaluateBoardAnimations(compiled, { a: 0 }).items.get("box")?.rotation, 20);
	assert.equal(evaluateBoardAnimations(compiled, { c: 30 }).items.get("box")?.rotation, 30);
});
