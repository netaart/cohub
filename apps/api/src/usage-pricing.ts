import { billingOperations, type PricingSubject } from "@cohub/billing";
import { createUsagePricing } from "@cohub/core/usage-pricing";
import { createLogger } from "@cohub/infra/logging";
import { config } from "./config.js";

const logger = createLogger({ serviceName: "cohub-api" });

export const usagePricing = createUsagePricing({
  billing: billingOperations,
  platformConfigRoot: config.platformConfigRoot,
  onConfigError: (error) => logger.error("[Billing] invalid pricing config; keeping the last valid rules", { error }),
});

/**
 * Prices a metered call once at admission; the balance gate and the settlement both use this result,
 * whatever the file or clock say by settlement. `subjects` lists every call the request may bill (the
 * main model and any fallback); it is free only if all of them are. Returns null, logged, when benefits
 * a matching rule needs cannot be read, so the caller fails before any provider call.
 */
export async function admitPricing(userId: string, subjects: readonly PricingSubject[]) {
  try {
    const price = await usagePricing.freeze(userId, subjects);
    const quotes = await Promise.all(subjects.map((subject) => price(subject)));
    return { price, free: quotes.every((quote) => quote.personal.multiplier === 0) };
  } catch (error) {
    logger.error("[Billing] pricing unavailable at admission", { userId, models: subjects.map((subject) => subject.model), error });
    return null;
  }
}
