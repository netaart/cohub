import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import { createSpaceWalletBilling, createSpaceWalletTransfers, spaceWalletCustomerId, walletCreditsUsable } from "@cohub/core/space-wallet";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { SPACE_WALLET_TRANSFER_RECOVER_ATTEMPTS, SPACE_WALLET_TRANSFER_RECOVER_JOB, SPACE_WALLET_UPDATED_EVENT, type SpaceWalletTransferRecoverJobData } from "@cohub/protocol";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { redisCommandClient } from "./redis.js";
import { dispatchSpaceDomainEvent } from "./space-events.js";

const logger = createLogger({ serviceName: "cohub-api" });
const warn = (message: string, context: Record<string, unknown>) => logger.warn(message, context);

export const spaceWalletBilling = createSpaceWalletBilling({
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  warn,
});

const recoveryQueue = createBullmqQueue<SpaceWalletTransferRecoverJobData>(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-space-wallet",
});

export async function dispatchSpaceWalletUpdated(spaceId: string) {
  spaceWalletBilling.invalidate(spaceId);
  await dispatchSpaceDomainEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: SPACE_WALLET_UPDATED_EVENT,
    spaceId,
    sessionId: null,
    payload: { spaceId },
  }, { skipHooks: true }).catch((error) => logger.warn("Space wallet event failed", { spaceId, error }));
}

export const spaceWalletTransfers = createSpaceWalletTransfers({
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  redis: redisCommandClient,
  walletUsable: async (spaceId) => walletCreditsUsable(await spaceWalletBillingOperations.getCreditStatus({ userId: spaceWalletCustomerId(spaceId), createCustomer: false })),
  onSettled: dispatchSpaceWalletUpdated,
  scheduleRecovery: (transfer) => recoveryQueue.add(SPACE_WALLET_TRANSFER_RECOVER_JOB, { ...transfer, trace: injectTrace() }, {
    delay: 60_000,
    attempts: SPACE_WALLET_TRANSFER_RECOVER_ATTEMPTS,
    backoff: { type: "exponential", delay: 30_000 },
    ...defaultJobRetention,
  }),
  warn,
});
