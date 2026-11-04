import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import { createGenerationBillingReservations } from "@cohub/core/generation-billing";
import { createLogger } from "@cohub/infra/logging";
import { db } from "./db/index.js";

const logger = createLogger({ serviceName: "cohub-api" });

export const generationBilling = createGenerationBillingReservations({
  db,
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  warn: (message, context) => logger.warn(message, context),
});
