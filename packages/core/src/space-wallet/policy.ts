import type { BillingCreditStatus } from "@cohub/billing";
import { SPACE_WALLET_TRANSFER_BENEFIT_PREFIX } from "./transfer-policy.js";

export function walletCreditsUsable(credit: BillingCreditStatus): boolean {
  return Number.isFinite(credit.netUsd) && credit.globalAvailableUsd === 0 && credit.groups.every((group) => group.grants.every((grant) =>
    grant.remainingAmount <= 0 || grant.availableNow === false || grant.status !== "active" ||
    (grant.grantKind === "purchased" && grant.sourceType === "order") ||
    (grant.grantKind === "manual" && grant.sourceType === "manual" && !!grant.benefitKey?.startsWith(SPACE_WALLET_TRANSFER_BENEFIT_PREFIX)),
  ));
}
