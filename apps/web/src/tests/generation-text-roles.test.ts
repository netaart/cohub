import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import {
	generationTextRoleFields,
	missingRequiredRoles,
	roleTextBlocks,
} from "../lib/generation-text-roles";
import { song2Declaration } from "./fixtures/song2-declaration";

const withText = (
	text: Record<string, unknown>,
): PublicGenerationDeclaration => ({
	schema: "neta.generation.model.v1",
	model: "scratch",
	content: { input: [{ type: "text", ...text }] },
});

test("song2 declares prompt and lyrics as required and abc as optional", () => {
	assert.deepEqual(generationTextRoleFields(song2Declaration), [
		{ role: "prompt", required: true },
		{ role: "lyrics", required: true },
		{ role: "abc", required: false },
	]);
});

test("a text input without roles has no role fields", () => {
	for (const model of [
		withText({}),
		withText({ required: true, min: 1 }),
		withText({ roles: [] }),
		{
			schema: "neta.generation.model.v1",
			model: "image-only",
			content: { input: [{ type: "image" }] },
		} satisfies PublicGenerationDeclaration,
	]) {
		assert.deepEqual(generationTextRoleFields(model), []);
		assert.equal(roleTextBlocks(model, { prompt: "x" }), null);
	}
});

test("the count the declaration asks for decides how many leading roles are required", () => {
	const required = (text: Record<string, unknown>) =>
		generationTextRoleFields(withText({ roles: ["a", "b", "c"], ...text })).map(
			(field) => field.required,
		);
	assert.deepEqual(required({}), [false, false, false]);
	assert.deepEqual(required({ required: true }), [true, false, false]);
	assert.deepEqual(required({ required: true, min: 2 }), [true, true, false]);
	assert.deepEqual(required({ min: 3 }), [true, true, true]);
	assert.deepEqual(required({ min: 9 }), [true, true, true]);
});

test("lists only the required roles that are empty", () => {
	assert.deepEqual(missingRequiredRoles(song2Declaration, {}), [
		"prompt",
		"lyrics",
	]);
	assert.deepEqual(
		missingRequiredRoles(song2Declaration, { prompt: "p", lyrics: " " }),
		["lyrics"],
	);
	assert.deepEqual(
		missingRequiredRoles(song2Declaration, { prompt: "p", lyrics: "l" }),
		[],
	);
});
