import {
  billingOperations,
  describePricingOffer,
  quotePricing,
  type BillingActiveBenefit,
  type PricingModelOffer,
  type PricingSubject,
} from "@cohub/billing";
import { createLogger } from "@cohub/infra/logging";
import { usagePricing } from "./usage-pricing.js";

const logger = createLogger({ serviceName: "cohub-api" });
const NO_OFFER: PricingModelOffer = { offer: null, quota: null };

/**
 * Prices each listed model for the caller so pickers can show badges. Benefits are read at most once
 * per listing; if they cannot be read the public price is shown, since display never decides a charge.
 */
export async function priceModelListing<T>(
  userId: string,
  items: readonly T[],
  subjectOf: (item: T) => PricingSubject | null,
): Promise<PricingModelOffer[]> {
  const config = await usagePricing.loadConfig();
  let benefits: Promise<readonly BillingActiveBenefit[]> | null = null;
  const loadBenefits = () => {
    benefits ??= billingOperations.getActiveBenefits({ userId }).catch((error) => {
      logger.warn("[Billing] benefits unavailable; listing public prices", { userId, error });
      return [];
    });
    return benefits;
  };
  return Promise.all(items.map(async (item) => {
    const subject = subjectOf(item);
    if (!subject) return NO_OFFER;
    try {
      return describePricingOffer(config, await quotePricing({ config, subject, loadBenefits }));
    } catch (error) {
      logger.warn("[Billing] failed to price a listed model", { userId, model: subject.model, error });
      return NO_OFFER;
    }
  }));
}
