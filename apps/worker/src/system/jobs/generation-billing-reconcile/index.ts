import { createLogger } from "@cohub/infra/logging";
import { generationBilling } from "../../../generation-billing.js";
import { registerSystemJob } from "../../registry.js";

const logger = createLogger({ serviceName: "cohub-worker" });

export const GENERATION_BILLING_RECONCILE_JOB = "generation-billing-reconcile";
export const GENERATION_BILLING_RECONCILE_SCHEDULER_ID = "generation-billing-reconcile";
export const GENERATION_BILLING_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

registerSystemJob(GENERATION_BILLING_RECONCILE_JOB, async () => {
  const result = await generationBilling.reconcile();
  if (result.processed > 0) logger.info("[Billing] reconciled generation reservations", result);
  return result;
});
