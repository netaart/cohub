import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardEditor } from "../../src/board/editor/index.js";
import { boardMediaPresentation } from "../../src/board/model/index.js";
import { boardDocument, boardScene } from "./fixtures.js";

const image = (extra: Record<string, unknown> = {}) => ({ type: "image", props: { src: "a.png" }, size: { width: 100, height: 100 }, ...extra });

test("media presentation comes from the item, then the nearest frame, then whether a script drew it", () => {
	const scene = boardScene({
		game: { type: "frame", props: { presentation: "plain" }, size: { width: 800, height: 600 } },
		shelf: { type: "frame", parent: "game", props: { presentation: "card" }, size: { width: 200, height: 200 } },
		room: { type: "frame", parent: "game", size: { width: 200, height: 200 } },
		loose: image(),
		sprite: image({ parent: "room" }),
		print: image({ parent: "shelf" }),
		pinned: image({ parent: "game", props: { src: "a.png", presentation: "card" } }),
		clip: { type: "video", parent: "room", props: { src: "a.mp4" } },
		"~script-x-~world": { type: "frame", props: { decoration: "none" } },
		"~script-x-hero": image({ parent: "~script-x-~world" }),
		"~script-x-poster": image({ parent: "~script-x-~world", props: { src: "a.png", presentation: "card" } }),
	});
	const of = (id: string) => boardMediaPresentation(scene.get(id) as NonNullable<ReturnType<typeof scene.get>>, (key) => scene.get(key));
	assert.equal(of("loose"), "card");
	assert.equal(of("sprite"), "plain");
	assert.equal(of("clip"), "plain");
	assert.equal(of("print"), "card");
	assert.equal(of("pinned"), "card");
	assert.equal(of("~script-x-hero"), "plain");
	assert.equal(of("~script-x-poster"), "card");
	assert.equal(of("room"), "card");
});

test("read-only viewers open card media on tap but not plain media", () => {
	const editor = createBoardEditor({
		document: boardDocument({ items: { card: image(), plain: image({ props: { src: "a.png", presentation: "plain" } }) } }),
		readonly: true,
	});
	const item = (id: string) => editor.itemById(id) as NonNullable<ReturnType<typeof editor.itemById>>;
	assert.equal(editor.opensOnTap(item("card")), true);
	assert.equal(editor.opensOnTap(item("plain")), false);
	editor.destroy();
});
