import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import { validateBoardGeneration } from "../lib/board/board-generation";

const qwenTts = {
	schema: "neta.generation.model.v1",
	model: "qwen-audio-3.1-tts-flash",
	content: {
		input: [
			{ type: "text", required: true, min: 1, max: 1 },
			{ type: "audio", required: false, max: 1, sources: ["url"] },
		],
	},
	meta: { fields: { voice_prompt: { type: "string", optional: true } } },
} as unknown as PublicGenerationDeclaration;

test("board generation sends short text to the Qwen speech model", () => {
	assert.equal(
		validateBoardGeneration({ model: qwenTts, prompt: "你好", references: [] }),
		null,
	);
});
