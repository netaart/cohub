import {
  COHUB_BILLING_BENEFITS,
  COHUB_BILLING_CREDIT_UNITS,
  COHUB_BILLING_USAGE_TYPES,
  type GenerationModelDiscount,
  type CohubBillingUsageType,
} from "./interfaces.js";
import type { BillingUsageKind } from "./usage-gate.js";

const GENERATION_MODEL_DISCOUNT_BENEFIT_KEYS = new Set<string>([
  COHUB_BILLING_BENEFITS.proModelDiscount,
  COHUB_BILLING_BENEFITS.maxModelDiscount,
]);

export type GenerationModelDiscountEntitlement = {
  benefitKey: string;
  enabled: boolean;
  metadata: Record<string, string | number | boolean>;
  grantId?: string | null;
};

export class GenerationModelDiscountConfigError extends Error {
  constructor(benefitKey: string, model: string, value: unknown) {
    super(`Invalid generation model discount ${benefitKey}.${model}: ${String(value)}`);
    this.name = "GenerationModelDiscountConfigError";
  }
}

export class GenerationModelDiscountSnapshotMismatchError extends Error {
  constructor(model: string) {
    super(`Generation pricing changed for ${model}. Please retry the request.`);
    this.name = "GenerationModelDiscountSnapshotMismatchError";
  }
}

/**
 * Resolve the best (lowest) model discount from active entitlements.
 * Eligible models are defined entirely by benefit metadata keys — no code allowlist.
 * Missing model keys are skipped; present keys must be valid 0..1 numbers.
 */
export function resolveGenerationModelDiscount(input: {
  model: string;
  entitlements: Iterable<GenerationModelDiscountEntitlement>;
  resolvedAt?: string;
}): GenerationModelDiscount {
  const resolvedAt = input.resolvedAt ?? new Date().toISOString();
  let resolved: GenerationModelDiscount = {
    multiplier: 1,
    benefitKey: null,
    grantId: null,
    resolvedAt,
  };

  for (const entitlement of input.entitlements) {
    if (!GENERATION_MODEL_DISCOUNT_BENEFIT_KEYS.has(entitlement.benefitKey)) continue;
    if (!Object.hasOwn(entitlement.metadata, input.model)) continue;
    if (!entitlement.enabled) {
      throw new GenerationModelDiscountConfigError(entitlement.benefitKey, "enabled", false);
    }
    const value = entitlement.metadata[input.model];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new GenerationModelDiscountConfigError(entitlement.benefitKey, input.model, value);
    }
    if (value < resolved.multiplier) {
      resolved = {
        multiplier: value,
        benefitKey: entitlement.benefitKey,
        grantId: entitlement.grantId ?? null,
        resolvedAt,
      };
    }
  }

  return resolved;
}

export function isGenerationModelDiscountFree(discount: Pick<GenerationModelDiscount, "multiplier">): boolean {
  return discount.multiplier === 0;
}

export function reconcileGenerationModelDiscountSnapshot(input: {
  model: string;
  snapshot?: { multiplier: number; resolvedAt: string };
  resolved: GenerationModelDiscount;
}): { multiplier: number; resolvedAt: string } {
  if (!input.snapshot) {
    return {
      multiplier: input.resolved.multiplier,
      resolvedAt: input.resolved.resolvedAt,
    };
  }
  if (input.snapshot.multiplier !== input.resolved.multiplier) {
    throw new GenerationModelDiscountSnapshotMismatchError(input.model);
  }
  return input.snapshot;
}

export function applyGenerationModelDiscount(
  officialCostUsd: number | null | undefined,
  discount: Pick<GenerationModelDiscount, "multiplier"> & Partial<Pick<GenerationModelDiscount, "benefitKey">>,
): number {
  if (typeof officialCostUsd !== "number" || !Number.isFinite(officialCostUsd) || officialCostUsd <= 0) return 0;
  if (discount.multiplier === 0) return 0;
  if (!Number.isFinite(discount.multiplier) || discount.multiplier < 0 || discount.multiplier > 1) {
    throw new GenerationModelDiscountConfigError(discount.benefitKey ?? "unknown", "snapshot", discount.multiplier);
  }
  const unitsPerUsd = COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitsPerUsd;
  return Math.round(officialCostUsd * discount.multiplier * unitsPerUsd) / unitsPerUsd;
}

export function calculateGenerationUsageCharge(
  officialCostUsd: number | null | undefined,
  discount: Pick<GenerationModelDiscount, "multiplier"> & Partial<Pick<GenerationModelDiscount, "benefitKey">>,
): {
  officialCostUsd: number;
  amountUsd: number;
  discountMultiplier: number;
  skipReason: "missing_cost" | "discounted_free" | "discounted_below_minimum" | null;
} {
  const officialCost =
    typeof officialCostUsd === "number" && Number.isFinite(officialCostUsd) && officialCostUsd > 0
      ? officialCostUsd
      : 0;
  const amountUsd = applyGenerationModelDiscount(officialCostUsd, discount);
  const skipReason = officialCost <= 0
    ? "missing_cost"
    : amountUsd > 0
      ? null
      : discount.multiplier === 0
        ? "discounted_free"
        : "discounted_below_minimum";
  return {
    officialCostUsd: officialCost,
    amountUsd,
    discountMultiplier: discount.multiplier,
    skipReason,
  };
}

const GENERATION_CATEGORY_USAGE_TYPES = new Map<string, CohubBillingUsageType>([
  ["image", COHUB_BILLING_USAGE_TYPES.generationImage],
  ["video", COHUB_BILLING_USAGE_TYPES.generationVideo],
  ["audio", COHUB_BILLING_USAGE_TYPES.generationAudio],
  ["3d", COHUB_BILLING_USAGE_TYPES.generation3d],
  ["decision", COHUB_BILLING_USAGE_TYPES.generationDecision],
]);

export function resolveGenerationUsageType(category: string | null | undefined): CohubBillingUsageType {
  return (category && GENERATION_CATEGORY_USAGE_TYPES.get(category)) || COHUB_BILLING_USAGE_TYPES.generation;
}

/** Map a generation usage type onto the matching usage-gate kind. */
export function generationUsageKind(usageType: CohubBillingUsageType): BillingUsageKind {
  switch (usageType) {
    case COHUB_BILLING_USAGE_TYPES.generationImage:
      return "generation.image";
    case COHUB_BILLING_USAGE_TYPES.generationVideo:
      return "generation.video";
    case COHUB_BILLING_USAGE_TYPES.generationAudio:
      return "generation.audio";
    case COHUB_BILLING_USAGE_TYPES.generation3d:
      return "generation.3d";
    case COHUB_BILLING_USAGE_TYPES.generationLlm:
      return "llm.turn";
    case COHUB_BILLING_USAGE_TYPES.generationLlmRaw:
      return "llm.raw_completion";
    case COHUB_BILLING_USAGE_TYPES.generationDecision:
      return "llm.decision";
    default:
      return "generation";
  }
}

/** Normalize a provider cost into a positive USD amount suitable for recordUsage. */
export function normalizePositiveUsd(amount: number | null | undefined): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return 0;
  return Number(amount.toFixed(8));
}
