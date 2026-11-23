import assert from "node:assert/strict";
import { test } from "node:test";
import { boardScene } from "./fixtures.js";

test("media decoration comes from the item, then the nearest frame, then card", () => {
	const image = (extra: Record<string, unknown> = {}) => ({ type: "image", props: { src: "a.png" }, ...extra });
	const scene = boardScene({
		game: { type: "frame", props: { contentDecoration: "none" } },
		shelf: { type: "frame", parent: "game", props: { contentDecoration: "card" } },
		room: { type: "frame", parent: "game", props: { decoration: "none" } },
		loose: image(),
		sprite: image({ parent: "room" }),
		print: image({ parent: "shelf" }),
		pinned: image({ parent: "game", props: { src: "a.png", decoration: "card" } }),
	});
	assert.deepEqual(["loose", "sprite", "print", "pinned", "game", "room"].filter((id) => !scene.decorated(id)), ["sprite", "room"]);
});
