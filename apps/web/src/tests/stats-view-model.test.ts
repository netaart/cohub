import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyExecutionStats, type RequestMetric } from "@cohub/protocol/model";
import {
	buildStatsTimeline,
	buildStatsViewModel,
} from "../lib/stats-view-model.ts";

function request(overrides: Partial<RequestMetric> = {}): RequestMetric {
	return {
		id: "request",
		provider: "provider",
		model: "model",
		startedAt: 1_000,
		completedAt: 2_000,
		durationMs: 1_000,
		firstTokenMs: 200,
		outputDurationMs: 700,
		status: "completed",
		...overrides,
	};
}

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

test("buildStatsTimeline normalizes overlapping requests into one shared window", () => {
	const timeline = buildStatsTimeline([
		request({ id: "a", startedAt: 1_000, completedAt: 2_000 }),
		request({
			id: "b",
			startedAt: 1_500,
			completedAt: 3_000,
			durationMs: 1_500,
		}),
	]);

	assert.ok(timeline);
	assert.equal(timeline.durationMs, 2_000);
	assert.equal(timeline.requests[0]?.left, 0);
	assert.equal(timeline.requests[1]?.left, 25);
	assert.equal(timeline.requests[1]?.width, 75);
});

test("buildStatsTimeline stays hidden without at least two timestamped requests", () => {
	assert.equal(buildStatsTimeline([request()]), null);
	assert.equal(
		buildStatsTimeline([
			request(),
			request({ id: "b", startedAt: Number.NaN }),
		]),
		null,
	);
});
