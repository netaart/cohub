import assert from "node:assert/strict";
import { test } from "node:test";
import { createDisabledBillingOperations, type BillingCreditGrantStatus } from "@cohub/billing";
import { createSpaceWalletTransfers } from "./index.js";

const denominations = [100, 50, 20, 10, 5, 2, 1].map((amountUsd) => ({ key: `space_wallet_transfer_${amountUsd}`, amountUsd }));
const grant = (input: Partial<BillingCreditGrantStatus>) => ({ grantKind: "purchased", sourceType: "order", status: "active", availableNow: true, remainingAmountUsd: 0, originalAmountUsd: 0, ...input }) as BillingCreditGrantStatus;
const credit = (grants: BillingCreditGrantStatus[], netUsd = 100) => ({ netUsd, globalAvailableUsd: 0, groups: [{ key: "never" as const, remainingAmountUsd: 0, grants }] });

function setup(options: { failGrantAt?: number } = {}) {
  const debits = new Map<string, number>();
  const reversed = new Map<string, number>();
  const granted = new Map<string, number>();
  const scheduled: string[] = [];
  const disabled = createDisabledBillingOperations();
  const status = { configured: true, provider: "talesofai" as const };
  const billing = {
    ...disabled, status,
    async getCreditStatus() { return credit([grant({ remainingAmountUsd: 60, originalAmountUsd: 60 })]); },
    async sumTransactions(input: { operationId?: string }) {
      if (input.operationId) return { grantUsd: 0, consumeUsd: debits.get(input.operationId) ?? 0, reversalUsd: 0 };
      return { grantUsd: 0, consumeUsd: [...debits.values()].reduce((a, b) => a + b, 0), reversalUsd: [...reversed.values()].reduce((a, b) => a + b, 0) };
    },
    async preflightUsage() { return { allowed: true, tokenType: "usd_micro_cent", estimatedAmountUsd: 0, availableBalance: 0, netBalance: 0, shortfall: 0 }; },
    async recordUsage(input: { operationId: string; amountUsd: number }) {
      debits.set(input.operationId, input.amountUsd);
      return { status: "recorded" as const, amountUsd: input.amountUsd, tokenType: "usd_micro_cent", response: null };
    },
    async getUsageConsumption(input: { operationId: string }) {
      const amountUsd = debits.get(input.operationId);
      return amountUsd === undefined ? null : { amountUsd, reversedUsd: reversed.get(input.operationId) ?? 0 };
    },
    async reverseUsage(input: { originalOperationId: string; amountUsd: number }) {
      reversed.set(input.originalOperationId, input.amountUsd);
      return { amountUsd: input.amountUsd };
    },
  };
  let grantCalls = 0;
  const walletBilling = {
    ...disabled, status, businessKey: "cohub_space_wallet",
    async ensureCustomer(input: { userId: string }) { return input; },
    async listCreditDenominations() { return denominations; },
    async grantCredits(input: { operationId: string; benefitKey: string }) {
      if (grantCalls++ === options.failGrantAt) throw Object.assign(new Error("grant failed"), { status: 503 });
      const amountUsd = Number(input.benefitKey.slice("space_wallet_transfer_".length));
      granted.set(input.operationId, amountUsd);
      return { amountUsd };
    },
    async sumTransactions(input: { operationId?: string }) { return { grantUsd: granted.get(input.operationId ?? "") ?? 0, consumeUsd: 0, reversalUsd: 0 }; },
  };
  const locks = new Map<string, string>();
  const redis = {
    async get(key: string) { return locks.get(key) ?? null; },
    async set(key: string, value: string) { if (locks.has(key)) return null; locks.set(key, value); return "OK"; },
    async eval(_script: string, _keys: number, key: string) { locks.delete(key); return 1; },
  };
  const transfers = createSpaceWalletTransfers({
    billing, walletBilling, redis,
    walletUsable: async () => true,
    scheduleRecovery: async (transfer) => { scheduled.push(transfer.id); },
  });
  const ref = { id: "11111111-1111-4111-8111-111111111111", spaceId: "space", spaceName: "Space", userId: "user", actorName: "@user" };
  const credited = () => [...granted.values()].reduce((a, b) => a + b, 0);
  return { transfers, ref, debits, reversed, scheduled, credited };
}

test("a transient credit failure defers, and the final recovery refunds only the remainder", async () => {
  const fixture = setup({ failGrantAt: 1 });
  const result = await fixture.transfers.start({ ...fixture.ref, amountUsd: 37 });
  assert.equal(result.state, "processing");
  assert.deepEqual(fixture.scheduled, [fixture.ref.id]);
  const refunded = await fixture.transfers.recover(fixture.ref, "refund");
  assert.equal(refunded.state, "refunded");
  assert.equal(refunded.creditedUsd, 20);
  assert.equal(fixture.reversed.get(`swt:space:${fixture.ref.id}:debit`), 17);
  const after = await fixture.transfers.recover(fixture.ref, "credit");
  assert.equal(after.state, "refunded");
  assert.equal(fixture.credited(), 20);
});
