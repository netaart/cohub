import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpClient } from "../src/http.js";

function completedGenerationResponse(billing: unknown) {
	return {
		run: {
			taskType: "generation",
			status: "completed",
			result: {
				model: "gpt-image-2",
				output: [],
				cost: 0.04,
				billing,
			},
			errorMessage: null,
		},
		progress: null,
	};
}

function clientReturning(body: unknown) {
	return createHttpClient({
		baseUrl: "https://api.example.test",
		fetch: async () =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	});
}

test("generation wait accepts a zero billing discount multiplier", async () => {
	const client = clientReturning(
		completedGenerationResponse({
			officialCostUsd: 0.04,
			amountUsd: 0,
			discountMultiplier: 0,
			usageType: "generation.image",
			status: "skipped",
			reason: "discounted_free",
		}),
	);

	const result = await client.generations.wait("task-run-1");

	assert.deepEqual(result.billing, {
		officialCostUsd: 0.04,
		amountUsd: 0,
		discountMultiplier: 0,
		usageType: "generation.image",
		status: "skipped",
		reason: "discounted_free",
	});
});

test("generation wait rejects invalid billing discount multipliers", async (t) => {
	for (const multiplier of [-0.01, 1.01, "0.6", null]) {
		await t.test(String(multiplier), async () => {
			const client = clientReturning(
				completedGenerationResponse({
					officialCostUsd: 0.04,
					amountUsd: 0.024,
					discountMultiplier: multiplier,
					usageType: "generation.image",
					status: "recorded",
				}),
			);

			await assert.rejects(
				client.generations.wait("task-run-1"),
				/Generation task completed without a valid result/,
			);
		});
	}
});

test("generation wait reports the router request id of a failed task", async () => {
	const failedRun = (result: unknown) =>
		clientReturning({
			run: {
				taskType: "generation",
				status: "failed",
				result,
				errorMessage: "Generation provider is temporarily unavailable — HTTP 500",
			},
			progress: null,
		});

	await assert.rejects(
		failedRun({ requestId: "router-1", upstreamRequestIds: ["newapi-1"] }).generations.wait("task-run-1"),
		{ message: "Generation provider is temporarily unavailable — HTTP 500\ntask ID: task-run-1\nrequest ID: router-1" },
	);
	await assert.rejects(failedRun(null).generations.wait("task-run-1"), {
		message: "Generation provider is temporarily unavailable — HTTP 500\ntask ID: task-run-1",
	});
});
