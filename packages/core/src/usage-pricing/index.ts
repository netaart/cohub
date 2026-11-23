import {
  applyPricingMultiplier,
  COHUB_BILLING_USAGE_TYPES,
  EMPTY_PRICING_CONFIG,
  parsePricingConfig,
  pricingNeedsBenefits,
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
/** A price fixed at admission: quotes any usage subject against the rules, instant, and benefits it froze. */
export type FrozenPricing = (subject: PricingSubject) => Promise<PricingQuote>;

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

  async function quote(subject: PricingSubject & { userId: string }): Promise<PricingQuote> {
    return quotePricing({
      config: await loadConfig(),
      subject,
      loadBenefits: () => input.billing.getActiveBenefits({ userId: subject.userId }),
    });
  }

  /**
   * Freezes the rules, the instant, and the user's benefits for one usage so its charge does not move
   * if the file changes or a window closes before settlement. Benefits the known `subjects` need are
   * read now and a failed read throws, so it surfaces before anything is charged.
   */
  async function freeze(userId: string, subjects: readonly PricingSubject[]): Promise<FrozenPricing> {
    const config = await loadConfig();
    const at = new Date();
    let benefits: Promise<readonly BillingActiveBenefit[]> | null = null;
    const loadBenefits = () => {
      benefits ??= input.billing.getActiveBenefits({ userId }).catch((error: unknown) => {
        benefits = null;
        throw error;
      });
      return benefits;
    };
    if (subjects.some((subject) => pricingNeedsBenefits(config, { at, ...subject }))) await loadBenefits();
    return (subject: PricingSubject) => quotePricing({ config, subject: { at, ...subject }, loadBenefits });
  }

  return { loadConfig, quote, freeze };
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

/**
 * Lets the agent-turn balance gate admit turns a rule makes free for the user. Generation tasks, raw
 * completions, and decisions decide this from the price they freeze at admission instead.
 */
export function isFreeLlmUsage(pricing: UsagePricing) {
  return async (request: BillingUsageGateInput) => {
    if (request.usageKind !== "llm.turn") return false;
    const usageType = COHUB_BILLING_USAGE_TYPES.generationLlm;
    // Without an explicit model (the default runs), only rules that do not name models can match.
    const quote = await pricing.quote({ userId: request.userId, usageType, model: request.model ?? "", provider: request.provider ?? null });
    return quote.personal.multiplier === 0;
  };
}
