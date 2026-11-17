import assert from "node:assert/strict";
import { test } from "node:test";
import { getGenerationModelPickerItems } from "../lib/generation-model-catalog.ts";

const models = [
	{ model: "image-fast", title: "Fast Image" },
	{ model: "image-pro", title: "Pro Image", hidden: true },
	{ model: "video-pro", title: "Pro Video", hidden: true },
];

function ids(query?: string, selectedModelIds?: Iterable<string>) {
	return getGenerationModelPickerItems(models, { query, selectedModelIds }).map(
		(model) => model.model,
	);
}

test("generation picker hides models from default and fuzzy discovery", () => {
	assert.deepEqual(ids(), ["image-fast"]);
	assert.deepEqual(ids("Pro Image"), []);
	assert.deepEqual(ids("image-proo"), []);
	assert.deepEqual(ids("IMAGE-PRO"), []);
});

test("generation picker reveals an exact hidden model id", () => {
	assert.deepEqual(ids("image-pro"), ["image-pro"]);
});

test("generation picker keeps selected hidden models manageable", () => {
	assert.deepEqual(ids(undefined, ["video-pro"]), ["image-fast", "video-pro"]);
	assert.deepEqual(ids("video", ["video-pro"]), ["video-pro"]);
});

test("generation picker preserves catalog data and stable order", () => {
	const snapshot = structuredClone(models);
	assert.deepEqual(ids("image"), ["image-fast"]);
	assert.deepEqual(models, snapshot);
});
