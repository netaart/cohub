import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeCapabilities } from "@neta-art/cohub";
import {
	resolveApprovalModeFromTurns,
	resolveLocalModelFromTurns,
} from "../lib/features/session-chat/session-utils.ts";
import {
	getSupportedThinkingLevels,
	resolveLocalModel,
	toLocalModelCatalog,
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

test("ultra is offered only where declared and restores from a request", () => {
	const ultra: RuntimeCapabilities["models"][number] = {
		harness: "codex",
		provider: "openai",
		id: "ultra",
		name: "Ultra",
		reasoning: true,
		thinkingLevelMap: { ultra: "ultra" },
	};
	const [declared] = toLocalModelCatalog([ultra]);
	assert(declared);
	assert.equal(getSupportedThinkingLevels(declared).at(-1), "ultra");
	assert.equal(
		resolveLocalModel([...catalog, ultra], {
			provider: "openai",
			id: "deep",
			thinkingLevel: "ultra",
		})?.thinkingLevel,
		"high",
	);
	assert.equal(
		resolveLocalModelFromTurns(
			[turn(1, "codex", { model: "ultra", thinkingLevel: "ultra" })],
			"codex",
		)?.thinkingLevel,
		"ultra",
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

test("Claude Code offers its default model and effort levels", () => {
	// Shape reported by the CLI adapter: no "off", effort low..max.
	const effort = {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	};
	const claude: RuntimeCapabilities["models"] = [
		{
			harness: "claude",
			provider: "anthropic",
			id: "default",
			name: "Default",
			isDefault: true,
			reasoning: true,
			thinkingLevelMap: effort,
		},
		{
			harness: "claude",
			provider: "anthropic",
			id: "haiku",
			name: "Claude Haiku",
		},
	];
	assert.deepEqual(resolveLocalModel(claude, null), {
		provider: "anthropic",
		id: "default",
		name: "Default",
		thinkingLevel: "high",
	});
	assert.deepEqual(
		getSupportedThinkingLevels(
			toLocalModelCatalog(claude)[0] as ReturnType<
				typeof toLocalModelCatalog
			>[number],
		),
		["low", "medium", "high", "xhigh", "max"],
	);
});

test("Fast follows to models that offer it and restores from the request", () => {
	const fastCatalog: RuntimeCapabilities["models"] = [
		{ ...catalog[0], serviceTiers: [{ id: "priority", name: "Fast" }] },
		{ ...catalog[1], serviceTiers: [{ id: "priority", name: "Fast" }] },
		catalog[2],
	];
	const fast = { provider: "openai", id: "default", serviceTier: "priority" };
	assert.equal(resolveLocalModel(fastCatalog, fast)?.serviceTier, "priority");
	assert.equal(
		resolveLocalModel(fastCatalog, { ...fast, id: "deep" })?.serviceTier,
		"priority",
	);
	assert.equal(
		resolveLocalModel(fastCatalog, { ...fast, id: "plain" })?.serviceTier,
		undefined,
	);
	const sent = {
		...turn(1, "codex", { model: "default" }),
		meta: {
			harness: "codex",
			provider: "openai",
			model: "default",
			requestedServiceTier: "priority",
		},
	};
	assert.equal(
		resolveLocalModelFromTurns([sent], "codex")?.serviceTier,
		"priority",
	);
	// A request for the Harness default still restores its tier, without naming a model.
	const defaultRequest = {
		...sent,
		meta: { harness: "codex", requestedServiceTier: "priority" },
	};
	const restored = resolveLocalModelFromTurns([defaultRequest], "codex");
	assert.deepEqual(restored, { serviceTier: "priority" });
	assert.deepEqual(resolveLocalModel(fastCatalog, restored), {
		provider: "openai",
		id: "default",
		name: "Default model",
		thinkingLevel: "medium",
		serviceTier: "priority",
	});
});

test("the approval mode restores from the last Turn that chose one", () => {
	const withMode = (
		sequence: number,
		harness: "codex" | "pi",
		approvalMode?: string,
	) => ({
		...turn(sequence, harness),
		meta: { harness, ...(approvalMode ? { approvalMode } : {}) },
	});
	const turns = [
		withMode(1, "codex", "read_only"),
		withMode(2, "codex"),
		withMode(3, "pi"),
	];
	assert.equal(resolveApprovalModeFromTurns(turns, "codex"), "read_only");
	assert.equal(resolveApprovalModeFromTurns(turns, "pi"), null);
	assert.equal(
		resolveApprovalModeFromTurns(
			[...turns, withMode(4, "codex", "full_access")],
			"codex",
		),
		"full_access",
	);
	assert.equal(
		resolveApprovalModeFromTurns([withMode(1, "codex", "ask")], "codex"),
		null,
	);
});
