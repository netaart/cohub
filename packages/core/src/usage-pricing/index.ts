import {
  applyPricingMultiplier,
  COHUB_BILLING_USAGE_TYPES,
  EMPTY_PRICING_CONFIG,
  parsePricingConfig,
  quotePricing,
  type BillingActiveBenefit,
  type BillingOperations,
  type BillingUsageGateInput,
  type PricingConfig,
  type PricingDiscount,
  type PricingQuote,
  type PricingSubject,
} from "@cohub/billing";
import { createPlatformConfigFile } from "@cohub/infra/config-runtime/platform-config-file";
import { parse } from "yaml";

export const PRICING_CONFIG_PATH = "platform/.cohub/billing/pricing.yaml";

const pricingFile = createPlatformConfigFile<PricingConfig>({
  path: PRICING_CONFIG_PATH,
  parse: (rawText) => parsePricingConfig(parse(rawText)),
  empty: EMPTY_PRICING_CONFIG,
});

export const clearPricingConfigCache = pricingFile.clear;

export type UsagePricing = ReturnType<typeof createUsagePricing>;

/**
 * Prices usage from the hot-reloaded platform `pricing.yaml`. A broken file keeps the last valid rules
 * (or none), so a typo never blocks usage; benefit lookups fail loudly because guessing would misprice.
 */
export function createUsagePricing(input: {
  billing: Pick<BillingOperations, "getActiveBenefits">;
  platformConfigRoot: string;
  onConfigError: (error: unknown) => void;
}) {
  const loadConfig = () => pricingFile.load(input.platformConfigRoot, input.onConfigError);

  async function quote(
    subject: PricingSubject & { userId: string },
    loadBenefits?: () => Promise<readonly BillingActiveBenefit[]>,
  ): Promise<PricingQuote> {
    return quotePricing({
      config: await loadConfig(),
      subject,
      loadBenefits: loadBenefits ?? (() => input.billing.getActiveBenefits({ userId: subject.userId })),
    });
  }

  /**
   * Pricing for a charge that already happened. If benefits cannot be read, the public price (every
   * rule without a benefit condition) still applies rather than dropping the charge or the campaign.
   */
  async function quoteCharge(subject: PricingSubject & { userId: string }, warn?: (message: string, context: Record<string, unknown>) => void) {
    try {
      return await quote(subject);
    } catch (error) {
      warn?.("[Billing] benefits unavailable; charging the public price", { userId: subject.userId, model: subject.model, usageType: subject.usageType, error });
      return quote(subject, async () => []);
    }
  }

  return { loadConfig, quote, quoteCharge };
}

/** Appends the pricing facts the balance ledger renders; list-price usage keeps its plain reason. */
export function pricedReason(
  reason: string,
  input: { officialUsd: number; discount: PricingDiscount; quota?: { covered: number; requested: number } | null },
): string {
  const parts: string[] = [];
  if (input.discount.multiplier < 1) parts.push(`x=${input.discount.multiplier}`);
  if (input.quota && input.quota.covered > 0) parts.push(`quota=${input.quota.covered}/${input.quota.requested}`);
  if (parts.length === 0) return reason;
  return `${reason} [list=${Number(input.officialUsd.toFixed(8))};${parts.join(";")}]`;
}

/** Prices a metered usage after the fact (LLM turns, raw completions, decisions) for either payer. */
export function priceUsage(quote: PricingQuote, officialUsd: number, reason: string) {
  return {
    amountUsd: applyPricingMultiplier(officialUsd, quote.personal.multiplier),
    reason: pricedReason(reason, { officialUsd, discount: quote.personal }),
    spaceWalletCharge: {
      amountUsd: applyPricingMultiplier(officialUsd, quote.spaceWallet.multiplier),
      reason: pricedReason(reason, { officialUsd, discount: quote.spaceWallet }),
    },
  };
}

const LLM_USAGE_TYPES: Record<string, string> = {
  "llm.turn": COHUB_BILLING_USAGE_TYPES.generationLlm,
  "llm.raw_completion": COHUB_BILLING_USAGE_TYPES.generationLlmRaw,
  "llm.decision": COHUB_BILLING_USAGE_TYPES.generationDecision,
};

/** Lets LLM balance gates admit usage a rule makes free for the user; generation tasks price themselves. */
export function isFreeLlmUsage(pricing: UsagePricing) {
  return async (request: BillingUsageGateInput) => {
    const usageType = LLM_USAGE_TYPES[request.usageKind];
    if (!usageType || !request.model) return false;
    const quote = await pricing.quote({ userId: request.userId, usageType, model: request.model, provider: request.provider ?? null });
    return quote.personal.multiplier === 0;
  };
}
