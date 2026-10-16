import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import {
	arrayParameterText,
	modelAcceptsGenerationReferences,
	parseArrayParameterText,
	regenerationRequestFromTaskRun,
	validateBoardGenerationParameters,
} from "../lib/board/board-generation";
import { isValidCachedGenerationModel } from "../lib/stores/generation-models-validation";

const meshy = {
	schema: "neta.generation.model.v1",
	model: "meshy",
	content: { input: [] },
	parameters: {
		operation: { type: "string", enum: ["text-to-3d", "image-to-3d"] },
	},
	operations: {
		"text-to-3d": {
			content: { input: [{ type: "text", required: true, min: 1, max: 16 }] },
			parameters: {
				target_formats: {
					type: "array",
					optional: true,
					items: { type: "string", enum: ["glb", "obj", "fbx"] },
					min: 1,
					unique: true,
				},
				polycount_levels: {
					type: "array",
					optional: true,
					items: { type: "integer", min: 1, max: 4 },
					max: 2,
				},
			},
		},
		"image-to-3d": {
			content: { input: [{ type: "image", required: true, min: 1, max: 1 }] },
		},
	},
} as unknown as PublicGenerationDeclaration;

const textTo3d = {
	...meshy,
	parameters: {
		...meshy.parameters,
		...meshy.operations?.["text-to-3d"].parameters,
	},
} as PublicGenerationDeclaration;

test("array parameters are cached only when their item declaration is valid", () => {
	const base = {
		schema: "neta.generation.model.v1",
		model: "meshy",
		content: { input: [] },
	};
	const valid = {
		...base,
		parameters: {
			target_formats: {
				type: "array",
				items: { type: "string", enum: ["glb"] },
				examples: [["glb"]],
			},
		},
	};
	assert.equal(isValidCachedGenerationModel(valid), true);
	assert.equal(
		isValidCachedGenerationModel({
			...base,
			parameters: { target_formats: { type: "array" } },
		}),
		false,
	);
	assert.equal(
		isValidCachedGenerationModel({
			...base,
			parameters: {
				target_formats: { type: "array", items: { type: "string" }, min: "1" },
			},
		}),
		false,
	);
	assert.equal(
		isValidCachedGenerationModel({
			...base,
			parameters: {
				target_formats: {
					type: "array",
					items: { type: "integer", enum: [1] },
				},
			},
		}),
		false,
	);
});

test("a 3d content input is cached as a valid content type", () => {
	const declaration = {
		schema: "neta.generation.model.v1",
		model: "meshy-rigging",
		content: { input: [{ type: "3d", required: true, min: 1, max: 1 }] },
	};
	assert.equal(isValidCachedGenerationModel(declaration), true);
});

test("the composer validates the selected operation's array parameters", () => {
	const validate = (parameters: Record<string, unknown>) =>
		validateBoardGenerationParameters(textTo3d, {
			operation: "text-to-3d",
			...parameters,
		});
	assert.equal(validate({ target_formats: ["glb", "fbx"] }), null);
	assert.equal(
		validate({ target_formats: ["usdz"] }),
		"Choose a valid target formats.",
	);
	assert.equal(
		validate({ target_formats: ["glb", "glb"] }),
		"target_formats must not repeat items.",
	);
	assert.equal(
		validate({ polycount_levels: [1, 2, 3] }),
		"polycount_levels allows at most 2 items.",
	);
	assert.equal(
		validate({ polycount_levels: [1, 5] }),
		"polycount_levels must be at most 4.",
	);
	assert.equal(
		validate({ polycount_levels: "1" }),
		"polycount_levels must be a list.",
	);
});

test("parseArrayParameterText splits text by the declared item type", () => {
	assert.deepEqual(
		parseArrayParameterText(" glb, obj ,,", { type: "string" }),
		["glb", "obj"],
	);
	assert.deepEqual(
		parseArrayParameterText("1, 3", { type: "integer" }),
		[1, 3],
	);
	assert.deepEqual(
		parseArrayParameterText("1, x", { type: "integer" }).map(Number.isNaN),
		[false, true],
	);
	assert.equal(arrayParameterText(["glb", "obj"]), "glb, obj");
	assert.equal(arrayParameterText(undefined), "");
});

test("reference compatibility uses the operations that accept the references", () => {
	const image = {
		id: "a",
		type: "image" as const,
		url: "https://example.com/a.png",
		label: "a",
	};
	assert.equal(modelAcceptsGenerationReferences(meshy, [image]), true);
	assert.equal(
		modelAcceptsGenerationReferences(meshy, [image, { ...image, id: "b" }]),
		false,
	);
});

test("regeneration accepts a task whose input is a 3d model", () => {
	const request = regenerationRequestFromTaskRun(
		{
			taskType: "generation",
			spaceId: "space",
			payload: {
				data: {
					model: "meshy",
					content: [
						{
							type: "3d",
							source: { type: "url", url: "https://example.com/model.glb" },
						},
					],
					parameters: { operation: "rigging" },
				},
			},
		} as never,
		"space",
	);
	assert.deepEqual(request.content, [
		{
			type: "3d",
			source: { type: "url", url: "https://example.com/model.glb" },
		},
	]);
});
