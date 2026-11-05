import assert from "node:assert/strict";
import { test } from "node:test";
import { getBuiltinGenerationModel } from "@neta-art/generation";
import type { PublicGenerationDeclaration } from "@neta-art/cohub";
import { filterHiddenLlmModels, formatGenerationPrice, formatLlmModelCost, operationLines, toMultimodalModelSummary } from "../src/commands/models.js";

test("formatGenerationPrice renders a flat unit price", () => {
	assert.equal(formatGenerationPrice({ unit: "image", amount: 0.04 }), "$0.04 / image");
});

test("formatGenerationPrice preserves tiny per-token precision", () => {
	assert.equal(formatGenerationPrice({ unit: "1m_tokens", amount: 0.0003 }), "$0.0003 / 1M tokens");
});

test("formatGenerationPrice drops fractional digits on whole dollars", () => {
	assert.equal(formatGenerationPrice({ unit: "image", amount: 5 }), "$5 / image");
});

test("formatGenerationPrice renders a free model without a fake fraction", () => {
	assert.equal(formatGenerationPrice({ unit: "image", amount: 0 }), "$0 / image");
});

test("formatGenerationPrice renders a min–max range when the price varies", () => {
	assert.equal(formatGenerationPrice({ unit: "second", min: 0.1, max: 0.5 }), "$0.10–$0.50 / second");
});

test("formatGenerationPrice collapses an equal min–max range", () => {
	assert.equal(formatGenerationPrice({ unit: "request", min: 0.02, max: 0.02 }), "$0.02 / request");
});

test("formatGenerationPrice appends a qualifier note", () => {
	assert.equal(
		formatGenerationPrice({ unit: "image", amount: 0.04, note: "std-pro" }),
		"$0.04 / image · std-pro",
	);
});

test("toMultimodalModelSummary keeps pricing structured for JSON output", () => {
	const declaration: PublicGenerationDeclaration = {
		schema: "neta.generation.model.v1",
		model: "gpt-image-2",
		title: "GPT Image 2",
		description: "Image generation model.",
		pricing: { unit: "image", amount: 0.04 },
		content: { input: [] },
	};

	assert.deepEqual(toMultimodalModelSummary(declaration), {
		model: "gpt-image-2",
		title: "GPT Image 2",
		description: "Image generation model.",
		pricing: { unit: "image", amount: 0.04 },
	});
});

test("toMultimodalModelSummary omits absent optional fields", () => {
	const declaration: PublicGenerationDeclaration = {
		schema: "neta.generation.model.v1",
		model: "unnamed-model",
		content: { input: [] },
	};

	assert.deepEqual(toMultimodalModelSummary(declaration), { model: "unnamed-model" });
});

test("Meshy model summaries retain the declared category", () => {
	const model = getBuiltinGenerationModel("meshy");
	assert.ok(model);
	assert.equal(toMultimodalModelSummary(model).category, "3d");
});

test("Meshy operation descriptions include media roles and string/integer array constraints", () => {
	const model = getBuiltinGenerationModel("meshy");
	assert.ok(model);
	const lines = operationLines(model);
	assert.equal(lines[0], "text-to-3d — Text To 3D");
	assert.ok(lines.includes("      type: array of string; optional; min items: 1; unique; values: glb, obj, fbx, stl, usdz, 3mf"));
	assert.ok(lines.includes("      type: array of integer; optional; min items: 1; max items: 10; unique; item min: 0"));
	assert.ok(lines.some((line) => line.includes("3d — required; min 1; max 2; sources: url; roles: motion")));
	assert.deepEqual(operationLines({ ...model, operations: undefined }), []);
});

test("formatLlmModelCost renders per-million-token input and output rates", () => {
	assert.equal(formatLlmModelCost({ cost: { input: 3, output: 15 } }), "$3 /M input · $15 /M output");
});

test("formatLlmModelCost appends cache rates when declared", () => {
	assert.equal(
		formatLlmModelCost({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }),
		"$3 /M input · $15 /M output · $0.30 /M cache read · $3.75 /M cache write",
	);
});

test("formatLlmModelCost omits zero-value components", () => {
	assert.equal(
		formatLlmModelCost({ cost: { input: 3, output: 15, cacheRead: 0 } }),
		"$3 /M input · $15 /M output",
	);
});

test("formatLlmModelCost preserves sub-cent precision", () => {
	assert.equal(formatLlmModelCost({ cost: { input: 0.0003, output: 0.0015 } }), "$0.0003 /M input · $0.0015 /M output");
});

test("formatLlmModelCost returns empty when cost is absent", () => {
	assert.equal(formatLlmModelCost({}), "");
});

test("formatLlmModelCost ignores a malformed cost bag", () => {
	assert.equal(formatLlmModelCost({ cost: { input: "free", output: 15 } }), "");
});

test("filterHiddenLlmModels drops hidden models", () => {
	const catalog = {
		anthropic: [
			{ model: { hidden: true } },
			{ model: {} },
			{ model: { hidden: false } },
		],
	};

	assert.deepEqual(filterHiddenLlmModels(catalog), { anthropic: [{ model: {} }, { model: { hidden: false } }] });
});

test("filterHiddenLlmModels removes providers with no visible models", () => {
	const catalog = {
		anthropic: [{ model: { hidden: true } }],
		openai: [{ model: {} }],
	};

	assert.deepEqual(filterHiddenLlmModels(catalog), { openai: [{ model: {} }] });
});

test("filterHiddenLlmModels returns an empty catalog when everything is hidden", () => {
	assert.deepEqual(filterHiddenLlmModels({ anthropic: [{ model: { hidden: true } }] }), {});
});
