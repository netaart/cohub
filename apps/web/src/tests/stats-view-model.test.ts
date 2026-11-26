import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyExecutionStats } from "@cohub/protocol/model";
import { buildStatsViewModel } from "../lib/stats-view-model.ts";

test("buildStatsViewModel shows each total once and explains it in breakdowns", () => {
	const stats = {
		...emptyExecutionStats(),
		turns: 2,
		calls: 3,
		toolCalls: 2,
		elapsedMs: 2_000,
		modelMs: 1_000,
		toolMs: 500,
		usage: {
			input: 100,
			cacheRead: 800,
			cacheWrite: 100,
			output: 500,
			totalTokens: 1_500,
		},
		modelCostUsd: 0.5,
	};

	const turn = buildStatsViewModel(stats, { scope: "turn", locale: "en" });
	const session = buildStatsViewModel(stats, {
		scope: "session",
		locale: "en",
	});

	assert.deepEqual(
		turn.totals.map((item) => item.key),
		["elapsed", "tokens", "modelCost"],
	);
	assert.deepEqual(
		session.totals.map((item) => item.key),
		["turns", "elapsed", "tokens", "modelCost"],
	);
	assert.deepEqual(
		turn.time?.segments.map((segment) => [segment.key, segment.share]),
		[
			["modelTime", 50],
			["toolTime", 25],
			["otherTime", 25],
		],
	);
	assert.deepEqual(
		turn.time?.facts.map((fact) => fact.key),
		["calls", "tools"],
	);
	assert.deepEqual(
		turn.tokens?.segments.map((segment) => [segment.key, segment.value]),
		[
			["cached", "800"],
			["input", "200"],
			["output", "500"],
		],
	);
	assert.deepEqual(turn.tokens?.facts, [{ key: "cache", value: "80%" }]);
});
