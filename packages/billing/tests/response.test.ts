import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeBillingBlocked, serializeBillingWarning } from "../src/response.js";
import { BillingAccessBlockedError } from "../src/errors.js";
import type { BillingAccessDecision } from "../src/usage-gate.js";
import { createBillingConversionIntent } from "../src/conversion.js";

const conversion = createBillingConversionIntent({
	level: "hard",
	reason: "negative_balance_limit_exceeded",
	source: "session_prompt",
});

test("serializeBillingBlocked produces the standard 402 body", () => {
	const decision = {
		status: "blocked",
		code: "billing_credit_limit_exceeded",
		balanceState: "negative",
		netUsd: -5,
		hardNegativeLimitUsd: -1,
		conversion,
	} satisfies Extract<BillingAccessDecision, { status: "blocked" }>;
	const body = serializeBillingBlocked(new BillingAccessBlockedError(decision));
	assert.equal(body.code, "billing_credit_limit_exceeded");
	assert.equal(body.billing.status, "blocked");
	assert.equal(body.billing.netUsd, -5);
	assert.equal(body.billing.hardNegativeLimitUsd, -1);
	assert.equal(body.billing.conversion, conversion);

	const withAction = serializeBillingBlocked(new BillingAccessBlockedError(decision), {
		actionUrl: "https://cohub.live/settings/billing",
	});
	assert.equal(withAction.billing.conversion.primaryAction.href, "https://cohub.live/settings/billing");
	assert.equal(body.billing.conversion.primaryAction.href, undefined);
});

test("serializeBillingBlocked includes a minimum balance when required", () => {
	const minimumBalanceConversion = createBillingConversionIntent({
		level: "hard",
		reason: "minimum_balance_not_met",
		source: "generation_task",
		title: "Insufficient balance",
		message: "Video generation requires a balance of at least $1.01.",
	});
	const decision = {
		status: "blocked",
		code: "billing_credit_limit_exceeded",
		balanceState: "positive",
		netUsd: 0.5,
		minimumBalanceUsd: 1.01,
		conversion: minimumBalanceConversion,
	} satisfies Extract<BillingAccessDecision, { status: "blocked" }>;
	const body = serializeBillingBlocked(new BillingAccessBlockedError(decision));

	assert.equal(body.message, "Insufficient balance for video generation.");
	assert.equal(body.billing.minimumBalanceUsd, 1.01);
	assert.equal(body.billing.hardNegativeLimitUsd, undefined);
	assert.equal(body.billing.conversion, minimumBalanceConversion);
});

test("serializeBillingWarning returns payload only for soft debt", () => {
	const warning = {
		status: "allowed_with_debt",
		balanceState: "negative",
		netUsd: -0.5,
		hardNegativeLimitUsd: -1,
		conversion,
	} satisfies Extract<BillingAccessDecision, { status: "allowed_with_debt" }>;
	const payload = serializeBillingWarning(warning);
	assert.ok(payload);
	assert.equal(payload.status, "allowed_with_debt");
	assert.equal(payload.conversion, conversion);

	assert.equal(serializeBillingWarning({ status: "allowed", balanceState: "zero", netUsd: 0 }), null);
	assert.equal(serializeBillingWarning(null), null);
});
