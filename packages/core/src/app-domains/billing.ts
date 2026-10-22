import {
  COHUB_BILLING_TOKEN_TYPES,
  COHUB_BILLING_USAGE_TYPES,
  type BillingOperations,
  type SpaceWalletBillingOperations,
} from "@cohub/billing";
import { APP_DOMAIN_PRICE_USD } from "@cohub/protocol";
import { spaceWalletCustomerId, walletCreditsUsable, type createSpaceWalletBilling } from "../space-wallet/index.js";

export type AppDomainBilling = {
  /** Whether the Space wallet or the user can pay the full price now. */
  canAfford(input: { spaceId: string; userId: string }): Promise<boolean>;
  charge(input: { domainId: string; hostname: string; spaceId: string; userId: string }): Promise<void>;
};

/**
 * Charges follow the Space wallet rule: the wallet pays the whole amount when
 * it can, otherwise the user who added the domain does.
 */
export function createAppDomainBilling(input: {
  billing: BillingOperations;
  walletBilling: SpaceWalletBillingOperations;
  spaceWalletBilling: ReturnType<typeof createSpaceWalletBilling>;
}): AppDomainBilling {
  const { billing, walletBilling } = input;
  const usageType = COHUB_BILLING_USAGE_TYPES.appDomain;
  const tokenType = COHUB_BILLING_TOKEN_TYPES.usdMicroCent;

  async function walletCanPay(spaceId: string) {
    if (!walletBilling.status.configured) return false;
    try {
      const userId = spaceWalletCustomerId(spaceId);
      const credit = await walletBilling.getCreditStatus({ userId, createCustomer: false });
      if (!walletCreditsUsable(credit) || credit.netUsd < APP_DOMAIN_PRICE_USD) return false;
      const preview = await walletBilling.preflightUsage({ userId, usageType, tokenType, estimatedAmountUsd: APP_DOMAIN_PRICE_USD });
      return preview.allowed && preview.shortfall === 0;
    } catch {
      return false;
    }
  }

  return {
    async canAfford({ spaceId, userId }) {
      if (!billing.status.configured) return true;
      if (await walletCanPay(spaceId)) return true;
      const preview = await billing.preflightUsage({ userId, usageType, tokenType, estimatedAmountUsd: APP_DOMAIN_PRICE_USD });
      return preview.allowed && preview.shortfall === 0;
    },
    async charge({ domainId, hostname, spaceId, userId }) {
      if (!billing.status.configured) return;
      await input.spaceWalletBilling.recordUsage({
        spaceId,
        userId,
        amountUsd: APP_DOMAIN_PRICE_USD,
        tokenType,
        usageType,
        sourceId: domainId,
        operationId: `app-domain:${domainId}`,
        reason: `Custom domain ${hostname}`,
      });
    },
  };
}
