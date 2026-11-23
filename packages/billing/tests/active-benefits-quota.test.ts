import assert from "node:assert/strict";
import { test } from "node:test";
import { createTalesofaiBillingOperations } from "../src/client.js";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const operations = () =>
	createTalesofaiBillingOperations({
		baseUrl: "https://billing.example.test/v1",
		businessKey: "cohub",
		adminApiKey: "test-key",
	});

async function withFetch(
	handler: (method: string, url: URL, body: Record<string, unknown> | null) => Response | null,
	run: () => Promise<void>,
) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		if (url.pathname === "/v1/customers" && method === "POST") {
			return jsonResponse({ customer: { external_user_id: "user_1" } });
		}
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
		const response = handler(method, url, body);
		if (!response) throw new Error(`Unexpected request: ${method} ${url}`);
		return response;
	};
	try {
		await run();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("active benefits map entitlement metadata", async () => {
	await withFetch((method, url) => {
		if (url.pathname !== "/v1/customers/user_1/entitlements" || method !== "GET") return null;
		return jsonResponse({
			customer: { id: "customer_1", external_user_id: "user_1", status: "active", meta: {} },
			business_key: "cohub",
			active_benefits: [{
				grant_id: "grant_max",
				benefit_id: "id:max",
				benefit_key: "max_model_discount_v1",
				benefit_name: "Max",
				benefit_type: "feature",
				config: { metadata: { "gpt-image-2": 0 } },
				source_type: "subscription_paid_period",
				source_id: "period_1",
				granted_at: "2026-07-01T00:00:00.000Z",
				effective_at: "2026-07-01T00:00:00.000Z",
				expires_at: "2026-08-01T00:00:00.000Z",
			}],
		});
	}, async () => {
		assert.deepEqual(await operations().getActiveBenefits({ userId: "user_1" }), [{
			benefitKey: "max_model_discount_v1",
			enabled: true,
			metadata: { "gpt-image-2": 0 },
			grantId: "grant_max",
		}]);
	});
});

test("quota consume reports the uncovered part and reversal reports cancelled debt in raw units", async () => {
	const sent: Array<Record<string, unknown>> = [];
	await withFetch((method, url, body) => {
		if (method !== "POST" || !body) return null;
		sent.push(body);
		if (url.pathname === "/v1/credits/consume") {
			return jsonResponse({ transactions: [], overage: { id: "overage_1", original_amount: 4, remaining_amount: 4 } });
		}
		if (url.pathname === "/v1/credits/consume/reverse") {
			return jsonResponse({ amount: 4, open_overage_cancelled_amount: 4 });
		}
		return null;
	}, async () => {
		const billing = operations();
		assert.deepEqual(await billing.consumeQuota({
			userId: "user_1",
			tokenType: "video_second",
			amount: 10,
			usageType: "generation.video",
			sourceId: "task_1",
			operationId: "generation-quota:task_1",
		}), { amount: 10, overage: 4 });
		assert.deepEqual(await billing.reverseQuota({
			userId: "user_1",
			tokenType: "video_second",
			originalOperationId: "generation-quota:task_1",
			operationId: "generation-quota:task_1:overage",
			amount: 4,
			reason: "quota overage",
		}), { amount: 4, overageCancelled: 4 });
	});
	assert.equal(sent[0]?.amount, 10);
	assert.equal(sent[0]?.token_type, "video_second");
	assert.equal(sent[1]?.amount, 4);
});

test("the activity feed lists a fully quota-covered usage at no charge and skips partial or refunded draws", async () => {
	const at = (minute: number) => `2026-11-21T00:0${minute}:00.000Z`;
	const tx = (id: string, minute: number, extra: Record<string, unknown>) => ({
		id, credit_grant_id: null, business_id: "b", customer_id: "c", source_type: "usage", source_id: id,
		usage_type: "generation.video", operation_id: null, reason: null, created_at: at(minute), ...extra,
	});
	const consumptions: Record<string, [number, number]> = {
		"generation-quota:full": [10, 0],
		"generation-quota:partial": [6, 0],
		"generation-quota:refunded": [10, 10],
	};
	await withFetch((method, url) => {
		if (method !== "GET") return null;
		if (url.pathname === "/v1/customers/user_1/credits") return jsonResponse({ credits: [] });
		if (url.pathname === "/v1/usage-overages") return jsonResponse({ items: [], pagination: { has_more: false } });
		if (url.pathname === "/v1/credit-transactions") {
			const items = url.searchParams.get("token_type") === "video_second"
				? ["full", "partial", "refunded"].map((id, index) => tx(`q-${id}`, index + 1, {
						token_type: "video_second", type: "consume", amount: 6,
						operation_id: `generation-quota:${id}`, reason: "Generation h3 [requested=10]",
					}))
				: [tx("paid", 5, { token_type: "usd_micro_cent", type: "consume", amount: 100_000_000, operation_id: "generation:partial", reason: "Generation h3 [list=2;quota=6/10]" })];
			return jsonResponse({ items, pagination: { has_more: false } });
		}
		const consumption = consumptions[decodeURIComponent(url.pathname.replace("/v1/credits/consumptions/", ""))];
		if (consumption) return jsonResponse({ original_amount: consumption[0], total_reversed: consumption[1] });
		return null;
	}, async () => {
		const list = await operations().listBalanceActivities({ userId: "user_1", createCustomer: false, quotaTokenTypes: ["video_second"] });
		assert.deepEqual(list.items.map((item) => [item.description, item.amountUsd, item.quota ?? null]), [
			["Generation h3 [list=2;quota=6/10]", -1, null],
			["Generation h3", 0, { tokenType: "video_second", units: 10 }],
		]);
	});
});
