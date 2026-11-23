import { billingOperations } from "@cohub/billing";
import { createUsagePricing } from "@cohub/core/usage-pricing";
import { createLogger } from "@cohub/infra/logging";
import { config } from "./config.js";

const logger = createLogger({ serviceName: "cohub-worker" });

export const usagePricing = createUsagePricing({
  billing: billingOperations,
  platformConfigRoot: config.platformConfigRoot,
  onConfigError: (error) => logger.error("[Billing] invalid pricing config; keeping the last valid rules", { error }),
});
