import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLocalModelFromTurns } from "../lib/features/session-chat/session-utils.ts";

const turn = (
	sequence: number,
	harness: "pi" | "codex" | "cohub",
	thinkingLevel?: string,
) => ({
	id: String(sequence),
	sequence,
	provider: "fixture",
	model: `${harness}-model`,
	meta: {
		harness,
		...(thinkingLevel ? { requestedThinkingLevel: thinkingLevel } : {}),
	},
});

test("local model and requested effort restore together for each harness", () => {
	const turns = [
		turn(1, "pi", "xhigh"),
		turn(2, "codex", "off"),
		turn(3, "cohub", "high"),
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
	assert.equal(resolveLocalModelFromTurns(turns, "cohub"), null);
});

test("a new model selection without effort clears the earlier override", () => {
	const turns = [
		turn(1, "pi", "high"),
		{ ...turn(2, "pi"), model: "new-model" },
	];
	assert.deepEqual(resolveLocalModelFromTurns(turns, "pi"), {
		provider: "fixture",
		id: "new-model",
	});
});

test("direct generations and effective defaults cannot become local effort overrides", () => {
	const turns = [
		{
			...turn(1, "pi"),
			meta: { harness: "pi", effectiveThinkingLevel: "high" },
		},
		{ ...turn(2, "pi", "max"), executionKind: "direct_generation" as const },
	];
	assert.deepEqual(resolveLocalModelFromTurns(turns, "pi"), {
		provider: "fixture",
		id: "pi-model",
	});
	assert.equal(resolveLocalModelFromTurns(turns, "codex"), null);
});
