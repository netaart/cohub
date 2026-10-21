import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildModelStatusResponse,
	type RawOnlineMetric,
	type RawOnlineWindow,
	type RawStatus,
} from "./model-status-transform.js";

const WINDOW_START = "2026-08-27T00:00:00.000Z";

function onlineWindow(
	minutes: number,
	metric: RawOnlineMetric,
): RawOnlineWindow {
	return { minutes, metric };
}

test("includes online-only models and reads the current online window shape", () => {
	const raw: RawStatus = {
		generated_at: "2026-08-27T01:00:00.000Z",
		overall_status: "operational",
		checks: [
			{
				model: "shared-model",
				instance: "neta",
				status: "operational",
				windows: {
					"5m": { sample_count: 1, success_rate: 100 },
				},
				history: [],
			},
		],
		online: {
			window: { start: WINDOW_START, minutes: 24 * 60 },
			models: [
				{
					model: "shared-model",
					status: "degraded",
					windows: [
						onlineWindow(5, {
							has_data: true,
							request_count: 4,
							success_count: 3,
							success_rate: 75,
						}),
					],
					heartbeats: [],
				},
				{
					model: "online-only",
					status: "degraded",
					windows: [
						onlineWindow(5, {
							has_data: true,
							request_count: 4,
							success_count: 3,
							success_rate: 75,
						}),
						onlineWindow(60, {
							has_data: true,
							request_count: 2,
							success_count: 1,
							success_rate: 50,
							duration_avg_ms: 1200,
							duration_p90_ms: 1800,
							last_checked: "2026-08-27T01:00:00.000Z",
						}),
						onlineWindow(1440, {
							has_data: true,
							request_count: 4,
							success_count: 3,
							success_rate: 75,
						}),
					],
					heartbeats: [
						{
							start: WINDOW_START,
							has_data: true,
							success_rate: 75,
						},
					],
				},
			],
		},
	};

	const result = buildModelStatusResponse(raw);
	const shared = result.models["shared-model"];
	const onlineOnly = result.models["online-only"];

	assert.ok(shared);
	assert.ok(onlineOnly);
	assert.equal(shared.successRate5m, 75);
	assert.equal(shared.successRateRecent, 75);
	assert.equal(shared.successRateRecentWindowMinutes, 5);
	assert.equal(onlineOnly.successRate5m, 75);
	assert.equal(onlineOnly.successRateRecent, 75);
	assert.equal(onlineOnly.successRateRecentWindowMinutes, 5);
	assert.equal(onlineOnly.successRate24h, 75);
	assert.equal(onlineOnly.latencyAvgMs, 1200);
	assert.equal(onlineOnly.latencyP90Ms, 1800);
	assert.equal(onlineOnly.heartbeats8h?.length, 96);
	assert.equal(onlineOnly.heartbeats8h?.[0], 75);
	assert.equal("samples1h" in onlineOnly, false);
});

test("falls back to probe data when online has no usable 5m samples", () => {
	const raw: RawStatus = {
		checks: [
			{
				model: "fallback-model",
				status: "operational",
				windows: { "5m": { sample_count: 2, success_rate: 100 } },
				history: [],
			},
		],
		online: {
			window: { start: WINDOW_START, minutes: 24 * 60 },
			models: [
				{
					model: "fallback-model",
					summary: {
						has_data: false,
						request_count: 0,
						last_checked: "0001-01-01T00:00:00.000Z",
					},
					windows: [
						onlineWindow(5, {
							has_data: false,
							request_count: 0,
							success_rate: 0,
							last_checked: "0001-01-01T00:00:00.000Z",
						}),
					],
					heartbeats: [],
				},
			],
		},
	};

	const entry = buildModelStatusResponse(raw).models["fallback-model"];
	assert.equal(entry?.successRate5m, 100);
	assert.equal(entry?.successRateRecent, 100);
	assert.equal(entry?.successRateRecentWindowMinutes, 5);
	assert.equal(entry?.checkedAt, null);
});

test("uses the shortest non-empty online window for the recent rate", () => {
	const raw: RawStatus = {
		overall_status: "operational",
		online: {
			window: { start: WINDOW_START, minutes: 24 * 60 },
			models: [
				{
					model: "sparse-model",
					status: "operational",
					windows: [
						onlineWindow(5, {
							has_data: false,
							request_count: 0,
							success_rate: 0,
						}),
						onlineWindow(10, {
							has_data: false,
							request_count: 0,
							success_rate: 0,
						}),
						onlineWindow(30, {
							has_data: true,
							request_count: 10,
							success_count: 9,
							success_rate: 90,
						}),
					],
					heartbeats: [],
				},
			],
		},
	};

	const entry = buildModelStatusResponse(raw).models["sparse-model"];
	assert.equal(entry?.successRate5m, null);
	assert.equal(entry?.successRateRecent, 90);
	assert.equal(entry?.successRateRecentWindowMinutes, 30);
});

test("leaves the recent rate empty when every recent window is empty", () => {
	const raw: RawStatus = {
		overall_status: "unknown",
		online: {
			window: { start: WINDOW_START, minutes: 24 * 60 },
			models: [
				{
					model: "idle-model",
					status: "unknown",
					windows: [5, 10, 30, 60].map((minutes) =>
						onlineWindow(minutes, {
							has_data: false,
							request_count: 0,
							success_rate: 0,
						}),
					),
					heartbeats: [],
				},
			],
		},
	};

	const entry = buildModelStatusResponse(raw).models["idle-model"];
	assert.equal(entry?.successRate5m, null);
	assert.equal(entry?.successRateRecent, null);
	assert.equal(entry?.successRateRecentWindowMinutes, null);
});
