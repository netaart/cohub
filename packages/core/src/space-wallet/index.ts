import { createBillingUsageGate, COHUB_BILLING_TOKEN_TYPES, type BillingOperations, type BillingUsageGate, type BillingUsageRecordInput, type BillingUsageRecordResult, type SpaceWalletBillingOperations } from "@cohub/billing";
import { walletCreditsUsable } from "./policy.js";

export { claimMessageWalletBilling, resolveWalletMessageEligibility } from "./message-claim.js";
export { walletCreditsUsable } from "./policy.js";
export const spaceWalletCustomerId = (spaceId: string) => `cohub:space-wallet:${spaceId}`;
/** `payer` pins the charge to the payer a reserve hold was placed on; retries then cannot switch payers. */
export type WalletUsageInput = BillingUsageRecordInput & { spaceId?: string | null; retryOnly?: boolean; payer?: "personal" | "space_wallet" | null };

function walletReason(userId: string, reason: string | undefined): string {
  const actorPrefix = `actor_user_id=${encodeURIComponent(userId)}; `;
  return actorPrefix + (reason ?? "").slice(0, Math.max(0, 1024 - actorPrefix.length));
}

export function createSpaceWalletBilling(input: {
  billing: BillingOperations;
  walletBilling: SpaceWalletBillingOperations;
  warn?: (message: string, context: Record<string, unknown>) => void;
}) {
  const { billing, walletBilling } = input;
  const emptyWallets = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();
  const personalGate = createBillingUsageGate({
    operations: billing,
    onEvaluationError: (error, request) => input.warn?.("Personal billing preflight failed", { spaceId: request.spaceId, error }),
  });

  async function creditFor(spaceId: string) {
    if ((emptyWallets.get(spaceId) ?? 0) > Date.now()) return null;
    const credit = await walletBilling.getCreditStatus({ userId: spaceWalletCustomerId(spaceId), createCustomer: false });
    if (credit.netUsd <= 0) {
      const oldest = emptyWallets.keys().next().value;
      if (emptyWallets.size >= 512 && oldest) emptyWallets.delete(oldest);
      emptyWallets.set(spaceId, Date.now() + 5_000);
    }
    return credit;
  }

  const gate: BillingUsageGate = {
    async evaluate(request) {
      const decision = await personalGate.evaluate(request);
      if (decision.status === "allowed" || !request.spaceId || !billing.status.configured || !walletBilling.status.configured) return decision;
      try {
        const credit = await creditFor(request.spaceId);
        if (!credit || !walletCreditsUsable(credit) || credit.netUsd <= 0) return decision;
        const walletGate = createBillingUsageGate({ operations: { getCreditStatus: async () => credit } });
        const walletDecision = await walletGate.evaluate(request);
        return walletDecision.status === "allowed" ? walletDecision : decision;
      } catch (error) {
        input.warn?.("Space wallet preflight failed", { spaceId: request.spaceId, error });
        return decision;
      }
    },
  };

  async function settle(request: WalletUsageInput): Promise<BillingUsageRecordResult> {
    const { spaceId, retryOnly, payer, ...usage } = request;
    // A pinned payer is idempotent under the same operation id, so its errors propagate for the caller to retry.
    if (payer === "personal") return billing.recordUsage(usage);
    if (payer === "space_wallet") {
      if (!spaceId) throw new Error("A Space wallet charge requires a spaceId");
      return walletBilling.recordUsage({ ...usage, userId: spaceWalletCustomerId(spaceId), reason: walletReason(usage.userId, usage.reason) });
    }
    if (!spaceId || !billing.status.configured || !walletBilling.status.configured || usage.amountUsd <= 0) return billing.recordUsage(usage);
    const tokenType = usage.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
    const skipped = { tokenType, amountUsd: usage.amountUsd, status: "skipped" as const, response: null };
    if (retryOnly) {
      input.warn?.("Space usage retry requires manual billing verification", { spaceId, operationId: usage.operationId });
      return skipped;
    }
    let walletPays = false;
    try {
      const credit = await creditFor(spaceId);
      if (credit && walletCreditsUsable(credit) && credit.netUsd >= usage.amountUsd) {
        const preview = await walletBilling.preflightUsage({ userId: spaceWalletCustomerId(spaceId), tokenType, usageType: usage.usageType, estimatedAmountUsd: usage.amountUsd });
        walletPays = preview.allowed && preview.shortfall === 0;
      }
    } catch (error) {
      input.warn?.("Space wallet preview failed; using original payer", { spaceId, operationId: usage.operationId, error });
    }
    try {
      const result = await (walletPays ? walletBilling : billing).recordUsage({
        ...usage,
        userId: walletPays ? spaceWalletCustomerId(spaceId) : usage.userId,
        reason: walletPays ? walletReason(usage.userId, usage.reason) : usage.reason,
      });
      if (walletPays && result.status === "overage") input.warn?.("Space wallet usage created overage", { spaceId, operationId: usage.operationId });
      return result;
    } catch (error) {
      // The debit may already have succeeded. Do not fall back or enqueue a rerouted charge.
      input.warn?.("Space usage debit failed; manual billing verification required", { spaceId, operationId: usage.operationId, sourceId: usage.sourceId, payerId: walletPays ? spaceWalletCustomerId(spaceId) : usage.userId, businessKey: walletPays ? walletBilling.businessKey : "personal", amountUsd: usage.amountUsd, error });
      return skipped;
    }
  }

  return {
    gate,
    invalidate(spaceId: string) { emptyWallets.delete(spaceId); },
    recordUsage(request: WalletUsageInput): Promise<BillingUsageRecordResult> {
      if (!request.spaceId || !walletBilling.status.configured) return settle(request);
      const key = request.spaceId;
      const result = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => settle(request));
      pending.set(key, result);
      void result.finally(() => { if (pending.get(key) === result) pending.delete(key); }).catch(() => undefined);
      return result;
    },
  };
}
