import { createBillingUsageGate, COHUB_BILLING_TOKEN_TYPES, type BillingOperations, type BillingUsageGate, type BillingUsageGateInput, type BillingUsageRecordInput, type BillingUsageRecordResult, type SpaceWalletBillingOperations } from "@cohub/billing";
import { spaceWalletCustomerId, walletActorReason } from "./customer.js";
import { walletCreditsUsable } from "./policy.js";

export { spaceWalletCustomerId } from "./customer.js";
export { claimMessageWalletBilling, resolveWalletMessageEligibility } from "./message-claim.js";
export { walletCreditsUsable } from "./policy.js";
export * from "./transfer.js";
/**
 * `payer` pins the charge to the payer a reserve hold was placed on; retries then cannot switch payers.
 * `spaceWalletCharge` is the price when the wallet pays, since personal benefits never discount it.
 */
export type WalletUsageInput = BillingUsageRecordInput & {
  spaceId?: string | null;
  retryOnly?: boolean;
  payer?: "personal" | "space_wallet" | null;
  spaceWalletCharge?: { amountUsd: number; reason?: string };
};

export type WalletUsageResult = BillingUsageRecordResult & { payer: "personal" | "space_wallet" };

export function createSpaceWalletBilling(input: {
  billing: BillingOperations;
  walletBilling: SpaceWalletBillingOperations;
  warn?: (message: string, context: Record<string, unknown>) => void;
  /** Usage the caller would not be charged for skips the balance gate. */
  isFreeUsage?: (request: BillingUsageGateInput) => Promise<boolean>;
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
      if (await input.isFreeUsage?.(request).catch(() => false)) return { status: "allowed", balanceState: "zero", netUsd: 0 };
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

  async function settle(request: WalletUsageInput): Promise<WalletUsageResult> {
    const { spaceId, retryOnly, payer, spaceWalletCharge, ...usage } = request;
    const personal = async () => ({ ...await billing.recordUsage(usage), payer: "personal" as const });
    const walletUsage = (id: string) => ({
      ...usage,
      ...(spaceWalletCharge ?? {}),
      userId: spaceWalletCustomerId(id),
      reason: walletActorReason(usage.userId, spaceWalletCharge?.reason ?? usage.reason),
    });
    // A pinned payer is idempotent under the same operation id, so its errors propagate for the caller to retry.
    if (payer === "personal") return personal();
    if (payer === "space_wallet") {
      if (!spaceId) throw new Error("A Space wallet charge requires a spaceId");
      return { ...await walletBilling.recordUsage(walletUsage(spaceId)), payer: "space_wallet" };
    }
    // Free for the user means free: a personal benefit that zeroes the price never routes the charge to a wallet.
    if (!spaceId || !billing.status.configured || !walletBilling.status.configured || usage.amountUsd <= 0) return personal();
    const walletAmountUsd = spaceWalletCharge?.amountUsd ?? usage.amountUsd;
    const tokenType = usage.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
    const skipped = { tokenType, amountUsd: usage.amountUsd, status: "skipped" as const, response: null, payer: "personal" as const };
    if (retryOnly) {
      input.warn?.("Space usage retry requires manual billing verification", { spaceId, operationId: usage.operationId });
      return skipped;
    }
    let walletPays = false;
    try {
      const credit = await creditFor(spaceId);
      if (credit && walletCreditsUsable(credit) && credit.netUsd >= walletAmountUsd) {
        const preview = await walletBilling.preflightUsage({ userId: spaceWalletCustomerId(spaceId), tokenType, usageType: usage.usageType, estimatedAmountUsd: walletAmountUsd });
        walletPays = preview.allowed && preview.shortfall === 0;
      }
    } catch (error) {
      input.warn?.("Space wallet preview failed; using original payer", { spaceId, operationId: usage.operationId, error });
    }
    try {
      const result = walletPays
        ? { ...await walletBilling.recordUsage(walletUsage(spaceId)), payer: "space_wallet" as const }
        : await personal();
      if (walletPays && result.status === "overage") input.warn?.("Space wallet usage created overage", { spaceId, operationId: usage.operationId });
      return result;
    } catch (error) {
      // The debit may already have succeeded. Do not fall back or enqueue a rerouted charge.
      input.warn?.("Space usage debit failed; manual billing verification required", { spaceId, operationId: usage.operationId, sourceId: usage.sourceId, payerId: walletPays ? spaceWalletCustomerId(spaceId) : usage.userId, businessKey: walletPays ? walletBilling.businessKey : "personal", amountUsd: walletPays ? walletAmountUsd : usage.amountUsd, error });
      return skipped;
    }
  }

  return {
    gate,
    invalidate(spaceId: string) { emptyWallets.delete(spaceId); },
    recordUsage(request: WalletUsageInput): Promise<WalletUsageResult> {
      if (!request.spaceId || !walletBilling.status.configured) return settle(request);
      const key = request.spaceId;
      const result = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => settle(request));
      pending.set(key, result);
      void result.finally(() => { if (pending.get(key) === result) pending.delete(key); }).catch(() => undefined);
      return result;
    },
  };
}
