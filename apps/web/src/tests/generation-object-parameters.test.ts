import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import { validateBoardGenerationParameters } from "../lib/board/board-generation.ts";
import { isValidCachedGenerationModel } from "../lib/stores/generation-models-validation.ts";

const song2 = {
	schema: "neta.generation.model.v1",
	model: "song2",
	content: { input: [{ type: "text" }] },
	parameters: {
		harmony: { type: "object", optional: true, description: "Section order." },
		seed: { type: "integer", optional: true, min: 0 },
	},
} as unknown as PublicGenerationDeclaration;

test("board generation accepts a JSON object for an object parameter", () => {
	assert.equal(
		validateBoardGenerationParameters(song2, {
			harmony: { follow: ["intro", "verse", "chorus", "outro"] },
		}),
		null,
	);
});

test("board generation rejects text and arrays for an object parameter", () => {
	assert.equal(
		validateBoardGenerationParameters(song2, {
			harmony: '{"follow":["verse"]}',
		}),
		"harmony must be a JSON object.",
	);
	assert.equal(
		validateBoardGenerationParameters(song2, { harmony: ["verse"] }),
		"harmony must be a JSON object.",
	);
});

test("board generation keeps checking numbers as before", () => {
	assert.equal(
		validateBoardGenerationParameters(song2, { seed: 1.5 }),
		"seed must be a valid integer.",
	);
	assert.equal(
		validateBoardGenerationParameters(song2, { seed: -1 }),
		"seed must be at least 0.",
	);
});

test("cached generation models keep declarations with object parameters", () => {
	assert.equal(isValidCachedGenerationModel(song2), true);
});

test("cached generation models reject an object parameter with a non-object default", () => {
	const broken = structuredClone(song2) as unknown as {
		parameters: Record<string, Record<string, unknown>>;
	};
	broken.parameters.harmony.default = "verse";
	assert.equal(isValidCachedGenerationModel(broken), false);
});
