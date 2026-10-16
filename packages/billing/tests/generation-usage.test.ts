import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyGenerationModelDiscount,
	calculateGenerationUsageCharge,
	contentTypesFromBlocks,
	GenerationModelDiscountConfigError,
	generationUsageKind,
	isGenerationModelDiscountFree,
	normalizePositiveUsd,
	reconcileGenerationModelDiscountSnapshot,
	resolveGenerationModelDiscount,
	resolveGenerationUsageType,
} from "../src/generation-usage.js";
import { COHUB_BILLING_USAGE_TYPES } from "../src/interfaces.js";

test("resolveGenerationUsageType prefers strict adapter families", () => {
	assert.equal(
		resolveGenerationUsageType({ adapterType: "openai.images", contentTypes: ["video"] }),
		COHUB_BILLING_USAGE_TYPES.generationImage,
	);
	assert.equal(
		resolveGenerationUsageType({ adapterType: "ark.videoGenerations" }),
		COHUB_BILLING_USAGE_TYPES.generationVideo,
	);
	assert.equal(
		resolveGenerationUsageType({ adapterType: "suno.tasks" }),
		COHUB_BILLING_USAGE_TYPES.generationMusic,
	);
	assert.equal(
		resolveGenerationUsageType({ adapterType: "kling.videoGenerations" }),
		COHUB_BILLING_USAGE_TYPES.generationVideo,
	);
	assert.equal(
		resolveGenerationUsageType({ adapterType: "meshy.tasks", contentTypes: ["text", "image"] }),
		COHUB_BILLING_USAGE_TYPES.generation3d,
	);
});

test("ambiguous adapters prefer content modality over adapter default", () => {
	assert.equal(
		resolveGenerationUsageType({ adapterType: "gemini.generateContent", contentTypes: ["video"] }),
		COHUB_BILLING_USAGE_TYPES.generationVideo,
	);
	assert.equal(
		resolveGenerationUsageType({ adapterType: "gemini.generateContent", contentTypes: ["audio"] }),
		COHUB_BILLING_USAGE_TYPES.generationMusic,
	);
	assert.equal(
		resolveGenerationUsageType({ adapterType: "gemini.generateContent", contentTypes: ["text"] }),
		COHUB_BILLING_USAGE_TYPES.generationImage,
	);
	assert.equal(
		resolveGenerationUsageType({ adapterType: "gemini.generateContent" }),
		COHUB_BILLING_USAGE_TYPES.generationImage,
	);
});

test("resolveGenerationUsageType falls back to content types for unknown adapters", () => {
	assert.equal(
		resolveGenerationUsageType({ contentTypes: ["text", "image"] }),
		COHUB_BILLING_USAGE_TYPES.generationImage,
	);
	assert.equal(
		resolveGenerationUsageType({ contentTypes: ["image", "video"] }),
		COHUB_BILLING_USAGE_TYPES.generationVideo,
	);
	assert.equal(
		resolveGenerationUsageType({ contentTypes: ["audio"] }),
		COHUB_BILLING_USAGE_TYPES.generationMusic,
	);
	assert.equal(
		resolveGenerationUsageType({ contentTypes: ["text", "image", "3d"] }),
		COHUB_BILLING_USAGE_TYPES.generation3d,
	);
	assert.equal(
		resolveGenerationUsageType({ contentTypes: ["3d", "video"] }),
		COHUB_BILLING_USAGE_TYPES.generationVideo,
	);
	assert.equal(
		resolveGenerationUsageType({ contentTypes: ["3d", "audio"] }),
		COHUB_BILLING_USAGE_TYPES.generationMusic,
	);
	assert.equal(
		resolveGenerationUsageType({ contentTypes: ["text"] }),
		COHUB_BILLING_USAGE_TYPES.generation,
	);
	assert.equal(resolveGenerationUsageType({}), COHUB_BILLING_USAGE_TYPES.generation);
});

test("contentTypesFromBlocks extracts block types", () => {
	assert.deepEqual(
		contentTypesFromBlocks([
			{ type: "text", text: "hi" },
			{ type: "image", source: { type: "url", url: "https://example.com/a.png" } },
			null,
			{ type: "  video  " },
		]),
		["text", "image", "video"],
	);
});

test("generationUsageKind maps ledger types onto gate kinds", () => {
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generationImage), "generation.image");
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generationVideo), "generation.video");
	assert.equal(generationUsageKind(COHUB_BILLING_USAGE_TYPES.generationMusic), "generation.music");
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

const resolvedAt = "2026-07-13T00:00:00.000Z";
const entitlement = (
	benefitKey: string,
	metadata: Record<string, string | number | boolean>,
) => ({ benefitKey, enabled: true, metadata, grantId: `grant:${benefitKey}` });

test("generation model discount defaults to full price without a matching entitlement", () => {
	assert.deepEqual(
		resolveGenerationModelDiscount({ model: "gpt-image-2", entitlements: [], resolvedAt }),
		{ multiplier: 1, benefitKey: null, grantId: null, resolvedAt },
	);
	assert.deepEqual(
		resolveGenerationModelDiscount({
			model: "gpt-image-2",
			entitlements: [entitlement("studio_pro_model_discount_v1", { "gpt-image-2": 0 })],
			resolvedAt,
		}),
		{ multiplier: 1, benefitKey: null, grantId: null, resolvedAt },
	);
	// Benefit present but model key absent in metadata → no discount (not a config error).
	assert.deepEqual(
		resolveGenerationModelDiscount({
			model: "gemini-3.1-flash-lite-image",
			entitlements: [entitlement("pro_model_discount_v1", { "gpt-image-2": 0.6 })],
			resolvedAt,
		}),
		{ multiplier: 1, benefitKey: null, grantId: null, resolvedAt },
	);
});

test("generation model discount is driven by metadata keys, not a code allowlist", () => {
	const discount = resolveGenerationModelDiscount({
		model: "any-new-model",
		entitlements: [entitlement("pro_model_discount_v1", { "any-new-model": 0.5 })],
		resolvedAt,
	});
	assert.deepEqual(discount, {
		multiplier: 0.5,
		benefitKey: "pro_model_discount_v1",
		grantId: "grant:pro_model_discount_v1",
		resolvedAt,
	});
});

test("Pro generation model discount charges sixty percent of official cost", () => {
	const discount = resolveGenerationModelDiscount({
		model: "gpt-image-2-auto",
		entitlements: [entitlement("pro_model_discount_v1", { "gpt-image-2-auto": 0.6 })],
		resolvedAt,
	});
	assert.deepEqual(discount, {
		multiplier: 0.6,
		benefitKey: "pro_model_discount_v1",
		grantId: "grant:pro_model_discount_v1",
		resolvedAt,
	});
	assert.equal(applyGenerationModelDiscount(0.1, discount), 0.06);
	assert.equal(isGenerationModelDiscountFree(discount), false);
});

test("Max generation model discount preserves zero as free", () => {
	const discount = resolveGenerationModelDiscount({
		model: "gemini-3.1-flash-image-preview-auto",
		entitlements: [
			entitlement("pro_model_discount_v1", { "gemini-3.1-flash-image-preview-auto": 0.6 }),
			entitlement("max_model_discount_v1", { "gemini-3.1-flash-image-preview-auto": 0 }),
		],
		resolvedAt,
	});
	assert.equal(discount.multiplier, 0);
	assert.equal(discount.benefitKey, "max_model_discount_v1");
	assert.equal(applyGenerationModelDiscount(0.1, discount), 0);
	assert.equal(isGenerationModelDiscountFree(discount), true);
});

test("generation model discount rounds once in usd_micro_cent units", () => {
	const discount = resolveGenerationModelDiscount({
		model: "gpt-image-2",
		entitlements: [entitlement("pro_model_discount_v1", { "gpt-image-2": 0.6 })],
		resolvedAt,
	});
	assert.equal(applyGenerationModelDiscount(0.000000006, discount), 0);
	assert.equal(applyGenerationModelDiscount(0.00000001, discount), 0.00000001);
	assert.equal(applyGenerationModelDiscount(0.00000002, discount), 0.00000001);
});

test("generation charge distinguishes missing provider cost, free pricing, and Pro pricing", () => {
	assert.deepEqual(calculateGenerationUsageCharge(undefined, { multiplier: 1 }), {
		officialCostUsd: 0,
		amountUsd: 0,
		discountMultiplier: 1,
		skipReason: "missing_cost",
	});
	assert.deepEqual(calculateGenerationUsageCharge(0.04, { multiplier: 0 }), {
		officialCostUsd: 0.04,
		amountUsd: 0,
		discountMultiplier: 0,
		skipReason: "discounted_free",
	});
	assert.deepEqual(calculateGenerationUsageCharge(0.04, { multiplier: 0.6 }), {
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
				resolvedAt,
			}),
			GenerationModelDiscountConfigError,
		);
	}
	// Disabled benefit with a matching model key is a config error.
	assert.throws(
		() => resolveGenerationModelDiscount({
			model: "gpt-image-2",
			entitlements: [{
				...entitlement("pro_model_discount_v1", { "gpt-image-2": 0.6 }),
				enabled: false,
			}],
			resolvedAt,
		}),
		GenerationModelDiscountConfigError,
	);
	// Disabled benefit without the requested model key is ignored.
	assert.deepEqual(
		resolveGenerationModelDiscount({
			model: "gpt-image-2",
			entitlements: [{
				...entitlement("pro_model_discount_v1", { "gpt-image-2-auto": 0.6 }),
				enabled: false,
			}],
			resolvedAt,
		}),
		{ multiplier: 1, benefitKey: null, grantId: null, resolvedAt },
	);
});

test("worker pricing reconciliation resolves legacy payloads and rejects stale or forged snapshots", () => {
	const resolved = resolveGenerationModelDiscount({
		model: "gpt-image-2",
		entitlements: [entitlement("pro_model_discount_v1", { "gpt-image-2": 0.6 })],
		resolvedAt,
	});
	assert.deepEqual(
		reconcileGenerationModelDiscountSnapshot({ model: "gpt-image-2", resolved }),
		{ multiplier: 0.6, resolvedAt },
	);
	const acceptedAt = "2026-07-13T00:01:00.000Z";
	assert.deepEqual(
		reconcileGenerationModelDiscountSnapshot({
			model: "gpt-image-2",
			snapshot: { multiplier: 0.6, resolvedAt: acceptedAt },
			resolved,
		}),
		{ multiplier: 0.6, resolvedAt: acceptedAt },
	);
	assert.throws(() => reconcileGenerationModelDiscountSnapshot({
		model: "gpt-image-2",
		snapshot: { multiplier: 0, resolvedAt: acceptedAt },
		resolved,
	}), /Generation pricing changed/);
});
