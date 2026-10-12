import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeCapabilities } from "@neta-art/cohub";
import { resolveLocalModelFromTurns } from "../lib/features/session-chat/session-utils.ts";
import { resolveLocalModel } from "../lib/model-catalog.ts";

const turn = (
	sequence: number,
	harness: "pi" | "codex" | "cohub",
	request: { model?: string; thinkingLevel?: string } = {},
) => ({
	id: String(sequence),
	sequence,
	// The model that answered; a Harness-default request fills it in too.
	provider: "fixture",
	model: "answered-model",
	meta: {
		harness,
		...(request.model ? { provider: "fixture", model: request.model } : {}),
		...(request.thinkingLevel
			? { requestedThinkingLevel: request.thinkingLevel }
			: {}),
	},
});

test("local requests restore per harness from what was sent", () => {
	const turns = [
		turn(1, "pi", { model: "pi-model", thinkingLevel: "xhigh" }),
		turn(2, "codex", { model: "codex-model", thinkingLevel: "off" }),
		turn(3, "cohub", { model: "cloud-model", thinkingLevel: "high" }),
	];
	assert.deepEqual(resolveLocalModelFromTurns(turns, "pi"), {
		provider: "fixture",
		id: "pi-model",
		thinkingLevel: "xhigh",
	});
	assert.deepEqual(resolveLocalModelFromTurns(turns, "codex"), {
		provider: "fixture",
		id: "codex-model",
		thinkingLevel: "off",
	});
});

test("a request without a model does not resurrect an earlier override", () => {
	const turns = [
		turn(1, "pi", { model: "pi-model", thinkingLevel: "xhigh" }),
		turn(2, "pi"),
	];
	assert.equal(resolveLocalModelFromTurns(turns, "pi"), null);
});

test("direct generations are not local requests", () => {
	const turns = [
		turn(1, "pi", { model: "pi-model" }),
		{
			...turn(2, "pi", { model: "image-model", thinkingLevel: "max" }),
			executionKind: "direct_generation" as const,
		},
	];
	assert.deepEqual(resolveLocalModelFromTurns(turns, "pi"), {
		provider: "fixture",
		id: "pi-model",
	});
});

const catalog: RuntimeCapabilities["models"] = [
	{
		harness: "codex",
		provider: "openai",
		id: "default",
		name: "Default model",
		isDefault: true,
		reasoning: true,
		defaultThinkingLevel: "medium",
		thinkingLevelMap: { off: "none", minimal: null, max: null },
	},
	{
		harness: "codex",
		provider: "openai",
		id: "deep",
		name: "Deep",
		reasoning: true,
		defaultThinkingLevel: "high",
		thinkingLevelMap: { off: null, minimal: null, low: null, max: null },
	},
	{ harness: "codex", provider: "openai", id: "plain", name: "Plain" },
];

test("without a request the Harness default model runs at its default level", () => {
	assert.deepEqual(resolveLocalModel(catalog, null), {
		provider: "openai",
		id: "default",
		name: "Default model",
		thinkingLevel: "medium",
	});
});

test("a requested level is clamped to the requested model", () => {
	assert.deepEqual(
		resolveLocalModel(catalog, {
			provider: "openai",
			id: "deep",
			thinkingLevel: "low",
		}),
		{ provider: "openai", id: "deep", name: "Deep", thinkingLevel: "medium" },
	);
	assert.equal(
		resolveLocalModel(catalog, { provider: "openai", id: "deep" })
			?.thinkingLevel,
		"high",
	);
});

test("a model without a level choice sends no level", () => {
	assert.deepEqual(
		resolveLocalModel(catalog, {
			provider: "openai",
			id: "plain",
			thinkingLevel: "high",
		}),
		{ provider: "openai", id: "plain", name: "Plain" },
	);
});

test("a model the Runtime no longer offers falls back to the default at its own level", () => {
	assert.deepEqual(
		resolveLocalModel(catalog, {
			provider: "openai",
			id: "removed",
			thinkingLevel: "xhigh",
		}),
		resolveLocalModel(catalog, null),
	);
});

test("a catalog without a declared default resolves only explicit requests", () => {
	const legacy = catalog.map(({ isDefault: _, ...model }) => model);
	assert.equal(resolveLocalModel(legacy, null), null);
	assert.equal(
		resolveLocalModel(legacy, { provider: "openai", id: "deep" })?.id,
		"deep",
	);
});
