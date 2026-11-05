import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import { createGenerationReserveHolds } from "@cohub/core/generation-billing";
import { createLogger } from "@cohub/infra/logging";
import { redisBestEffortCommandClient } from "./redis.js";

const logger = createLogger({ serviceName: "cohub-worker" });

export const generationReserveHolds = createGenerationReserveHolds({
  redis: redisBestEffortCommandClient,
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  warn: (message, context) => logger.warn(message, context),
});
