import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import { createSpaceWalletTransfers, spaceWalletCustomerId, walletCreditsUsable } from "@cohub/core/space-wallet";
import { createLogger } from "@cohub/infra/logging";
import {
  SPACE_WALLET_TRANSFER_CREDIT_ATTEMPTS,
  SPACE_WALLET_TRANSFER_RECOVER_JOB,
  SPACE_WALLET_UPDATED_EVENT,
  type SpaceWalletTransferRecoverJobData,
} from "@cohub/protocol";
import { REALTIME_OUTBOUND_CHANNEL } from "@cohub/protocol/realtime";
import type { Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { redisCommandClient } from "../../../redis.js";
import { spaceWalletBilling } from "../../../space-wallet-billing.js";
import { registerSystemJob } from "../../registry.js";

const logger = createLogger({ serviceName: "cohub-worker" });

const transfers = createSpaceWalletTransfers({
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  redis: redisCommandClient,
  walletUsable: async (spaceId) => walletCreditsUsable(await spaceWalletBillingOperations.getCreditStatus({ userId: spaceWalletCustomerId(spaceId), createCustomer: false })),
  scheduleRecovery: async () => undefined,
  onSettled: async (spaceId) => {
    spaceWalletBilling.invalidate(spaceId);
    await redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify({
      id: randomUUID(), timestamp: Date.now(), domain: "space", type: SPACE_WALLET_UPDATED_EVENT,
      spaceId, sessionId: null, payload: { spaceId },
    }));
  },
  warn: (message, context) => logger.warn(message, context),
});

registerSystemJob(SPACE_WALLET_TRANSFER_RECOVER_JOB, async (job: Job<SpaceWalletTransferRecoverJobData>) => {
  const { trace: _trace, ...transfer } = job.data;
  try {
    const result = await transfers.recover(transfer, job.attemptsMade < SPACE_WALLET_TRANSFER_CREDIT_ATTEMPTS ? "credit" : "refund");
    if (result.state === "none" && job.attemptsMade < 2) throw new Error("Space wallet transfer debit not found yet");
    return { ...result, spaceId: transfer.spaceId };
  } catch (error) {
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      logger.error("Space wallet transfer unrecovered; manual billing action required", { ...transfer, error });
    }
    throw error;
  }
});
