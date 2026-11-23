import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyPricingMultiplier,
	calculateUsageCharge,
	GenerationModelDiscountConfigError,
	generationUsageKind,
	normalizePositiveUsd,
	resolveGenerationModelDiscount,
	resolveGenerationUsageType,
} from "../src/generation-usage.js";
import { COHUB_BILLING_USAGE_TYPES } from "../src/interfaces.js";

test("resolveGenerationUsageType maps declaration categories", () => {
	assert.equal(resolveGenerationUsageType("image"), COHUB_BILLING_USAGE_TYPES.generationImage);
	assert.equal(resolveGenerationUsageType("video"), COHUB_BILLING_USAGE_TYPES.generationVideo);
	assert.equal(resolveGenerationUsageType("audio"), COHUB_BILLING_USAGE_TYPES.generationAudio);
	assert.equal(resolveGenerationUsageType("3d"), COHUB_BILLING_USAGE_TYPES.generation3d);
	assert.equal(resolveGenerationUsageType("decision"), COHUB_BILLING_USAGE_TYPES.generationDecision);
	assert.equal(resolveGenerationUsageType(undefined), COHUB_BILLING_USAGE_TYPES.generation);
	assert.equal(resolveGenerationUsageType("toString"), COHUB_BILLING_USAGE_TYPES.generation);
});

test("generationUsageKind maps ledger types onto gate kinds", () => {
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generationImage), "generation.image");
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generationVideo), "generation.video");
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generationAudio), "generation.audio");
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generation3d), "generation.3d");
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generation), "generation");
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generationLlm), "llm.turn");
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generationLlmRaw), "llm.raw_completion");
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generationDecision), "llm.decision");
});

test("normalizePositiveUsd rejects non-positive values", () => {
	assert.equal(normalizePositiveUsd(undefined), 0);
	assert.equal(normalizePositiveUsd(null), 0);
	assert.equal(normalizePositiveUsd(0), 0);
	assert.equal(normalizePositiveUsd(-1), 0);
	assert.equal(normalizePositiveUsd(Number.NaN), 0);
	assert.equal(normalizePositiveUsd(0.123456789), 0.12345679);
});

const entitlement = (
	benefitKey: string,
	metadata: Record<string, string | number | boolean>,
) => ({ benefitKey, enabled: true, metadata, grantId: `grant:${benefitKey}` });
const FULL_PRICE = { multiplier: 1, benefitKey: null };

test("generation model discount defaults to full price without a matching entitlement", () => {
	assert.deepEqual(resolveGenerationModelDiscount({ model: "gpt-image-2", entitlements: [] }), FULL_PRICE);
	assert.deepEqual(
		resolveGenerationModelDiscount({
			model: "gpt-image-2",
			entitlements: [entitlement("studio_pro_model_discount_v1", { "gpt-image-2": 0 })],
		}),
		FULL_PRICE,
	);
	assert.deepEqual(
		resolveGenerationModelDiscount({
			model: "gemini-3.1-flash-lite-image",
			entitlements: [entitlement("pro_model_discount_v1", { "gpt-image-2": 0.6 })],
		}),
		FULL_PRICE,
	);
});

test("generation model discount takes the lowest benefit multiplier from metadata keys", () => {
	assert.deepEqual(
		resolveGenerationModelDiscount({
			model: "any-new-model",
			entitlements: [
				entitlement("pro_model_discount_v1", { "any-new-model": 0.6 }),
				entitlement("max_model_discount_v1", { "any-new-model": 0 }),
			],
		}),
		{ multiplier: 0, benefitKey: "max_model_discount_v1" },
	);
});

test("pricing multiplier rounds once in usd_micro_cent units", () => {
	assert.equal(applyPricingMultiplier(0.1, 0.6), 0.06);
	assert.equal(applyPricingMultiplier(0.1, 0), 0);
	assert.equal(applyPricingMultiplier(0.000000006, 0.6), 0);
	assert.equal(applyPricingMultiplier(0.00000001, 0.6), 0.00000001);
	assert.equal(applyPricingMultiplier(0.00000002, 0.6), 0.00000001);
	assert.throws(() => applyPricingMultiplier(0.1, 1.5));
});

test("usage charge distinguishes missing provider cost, free pricing, and discounted pricing", () => {
	assert.deepEqual(calculateUsageCharge(undefined, 1), {
		officialCostUsd: 0,
		amountUsd: 0,
		discountMultiplier: 1,
		skipReason: "missing_cost",
	});
	assert.deepEqual(calculateUsageCharge(0.04, 0), {
		officialCostUsd: 0.04,
		amountUsd: 0,
		discountMultiplier: 0,
		skipReason: "discounted_free",
	});
	assert.deepEqual(calculateUsageCharge(0.04, 0.6), {
		officialCostUsd: 0.04,
		amountUsd: 0.024,
		discountMultiplier: 0.6,
		skipReason: null,
	});
});

test("generation model discount rejects invalid active configuration", () => {
	for (const value of ["0.6", -0.1, 1.1, Number.NaN]) {
		assert.throws(
			() => resolveGenerationModelDiscount({
				model: "gpt-image-2",
				entitlements: [entitlement("pro_model_discount_v1", { "gpt-image-2": value })],
			}),
			GenerationModelDiscountConfigError,
		);
	}
	assert.throws(
		() => resolveGenerationModelDiscount({
			model: "gpt-image-2",
			entitlements: [{ ...entitlement("pro_model_discount_v1", { "gpt-image-2": 0.6 }), enabled: false }],
		}),
		GenerationModelDiscountConfigError,
	);
	assert.deepEqual(
		resolveGenerationModelDiscount({
			model: "gpt-image-2",
			entitlements: [{ ...entitlement("pro_model_discount_v1", { "gpt-image-2-auto": 0.6 }), enabled: false }],
		}),
		FULL_PRICE,
	);
});
