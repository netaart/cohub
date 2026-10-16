import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeCapabilities } from "@neta-art/cohub";
import { resolveLocalModelFromTurns } from "../lib/features/session-chat/session-utils.ts";
import {
	isLocalServiceTierUnavailable,
	resolveLocalModel,
} from "../lib/model-catalog.ts";

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

const fastCatalog: RuntimeCapabilities["models"] = [
	{
		...catalog[0],
		serviceTiers: [
			{
				id: "priority",
				name: "Fast",
				description: "2x speed, increased usage",
			},
		],
		defaultServiceTier: null,
	},
];

test("Codex Fast preserves explicit on and off independently of model reasoning", () => {
	for (const serviceTier of ["priority", null] as const) {
		const resolved = resolveLocalModel(fastCatalog, {
			provider: "openai",
			id: "default",
			serviceTier,
		});
		assert.equal(resolved?.serviceTier, serviceTier);
		assert.equal(resolved?.thinkingLevel, "medium");
	}
	assert.equal(resolveLocalModel(fastCatalog, null)?.serviceTier, null);
	assert.equal(
		resolveLocalModel(
			[{ ...fastCatalog[0], defaultServiceTier: "priority" }],
			null,
		)?.serviceTier,
		"priority",
	);
});

test("local Fast restoration retains an explicit off after an earlier on", () => {
	const turns = ["priority", null].map((serviceTier, index) => ({
		...turn(index + 1, "codex", {
			model: "codex-model",
			thinkingLevel: "high",
		}),
		meta: {
			harness: "codex",
			provider: "fixture",
			model: "codex-model",
			requestedThinkingLevel: "high",
			requestedServiceTier: serviceTier,
		},
	}));
	assert.equal(
		resolveLocalModelFromTurns(turns.slice(0, 1), "codex")?.serviceTier,
		"priority",
	);
	assert.equal(resolveLocalModelFromTurns(turns, "codex")?.serviceTier, null);
	assert.equal(
		resolveLocalModelFromTurns(
			[turn(1, "codex", { model: "codex-model" })],
			"codex",
		)?.serviceTier,
		undefined,
	);
});

test("unsupported Fast remains visible but is blocked before sending", () => {
	const selection = resolveLocalModel(catalog, {
		provider: "openai",
		id: "default",
		serviceTier: "priority",
	});
	assert.equal(selection?.serviceTier, "priority");
	assert.equal(isLocalServiceTierUnavailable(catalog, selection), true);
	assert.equal(isLocalServiceTierUnavailable(fastCatalog, selection), false);
	assert.equal(
		isLocalServiceTierUnavailable(catalog, {
			provider: "openai",
			id: "default",
			serviceTier: null,
		}),
		true,
	);
	assert.equal(
		isLocalServiceTierUnavailable([{ ...catalog[0], serviceTiers: [] }], {
			provider: "openai",
			id: "default",
			serviceTier: null,
		}),
		false,
	);
	assert.throws(
		() =>
			resolveLocalModelFromTurns(
				[
					{
						...turn(1, "codex"),
						meta: {
							harness: "codex",
							provider: "fixture",
							model: "codex-model",
							requestedServiceTier: "broken",
						},
					},
				],
				"codex",
			),
		/service tier/i,
	);
});

test("a current Codex model without Fast explicitly clears a prior thread tier", () => {
	assert.equal(
		resolveLocalModel(
			[{ ...catalog[0], serviceTiers: [], defaultServiceTier: null }],
			null,
		)?.serviceTier,
		null,
	);
});
