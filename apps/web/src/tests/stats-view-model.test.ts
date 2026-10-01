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

test("buildStatsViewModel keeps turn and session presentation on one model", () => {
	const stats = {
		...emptyExecutionStats(),
		turns: 2,
		calls: 3,
		elapsedMs: 1_500,
		modelMs: 1_000,
		toolMs: 500,
		usage: { input: 1_000, output: 500, totalTokens: 1_500 },
	};

	const turn = buildStatsViewModel(stats, "turn", "en");
	const session = buildStatsViewModel(stats, "session", "en");

	assert.deepEqual(
		turn.hero.map((item) => item.label),
		["elapsed", "calls", "tokens"],
	);
	assert.deepEqual(
		session.hero.map((item) => item.label),
		["turns", "elapsed", "tokens"],
	);
	assert.equal(turn.timing.length, 2);
	assert.equal(turn.usage.length, 2);
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
