import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import { createSpaceWalletBilling } from "@cohub/core/space-wallet";
import { isFreeLlmUsage } from "@cohub/core/usage-pricing";
import { createLogger } from "@cohub/infra/logging";
import { usagePricing } from "./usage-pricing.js";

const logger = createLogger({ serviceName: "cohub-worker" });
export const spaceWalletBilling = createSpaceWalletBilling({
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  warn: (message, context) => logger.warn(message, context),
  isFreeUsage: isFreeLlmUsage(usagePricing),
});
