import assert from "node:assert/strict";
import { test } from "node:test";
import { createDisabledBillingOperations, type BillingUsageRecordInput } from "@cohub/billing";
import { createSpaceWalletBilling, spaceWalletCustomerId } from "./index.js";

const request = { spaceId: "space", userId: "user", amountUsd: 0.5, usageType: "generation.llm", sourceId: "message", operationId: "llm:message" };
function setup(balance: number, options: { enabled?: boolean; previewFails?: boolean; debitFails?: boolean } = {}) {
  const debits: BillingUsageRecordInput[] = [];
  const queries: string[] = [];
  const warnings: string[] = [];
  const billing = {
    ...createDisabledBillingOperations(),
    status: { configured: true, provider: "talesofai" as const },
    async getCreditStatus() { return { netUsd: 0, groups: [] }; },
    async recordUsage(input: BillingUsageRecordInput) {
      debits.push(input);
      if (options.debitFails) throw new Error("Debit response lost");
      return { status: "recorded" as const, amountUsd: input.amountUsd, tokenType: "usd_micro_cent", response: null };
    },
  };
  const walletBilling = {
    ...billing, businessKey: "cohub_space_wallet",
    status: { configured: options.enabled !== false, provider: "talesofai" as const },
    async getCreditStatus(input: { userId: string; createCustomer?: boolean }) {
      assert.equal(input.createCustomer, false);
      queries.push(input.userId);
      return { netUsd: balance, globalAvailableUsd: 0, groups: [] };
    },
    async preflightUsage() {
      if (options.previewFails) throw new Error("Preview unavailable");
      return { allowed: balance >= 0.5, tokenType: "usd_micro_cent", estimatedAmountUsd: 0.5, availableBalance: balance, netBalance: balance, shortfall: Math.max(0, 0.5 - balance) };
    },
    async recordUsage(input: BillingUsageRecordInput) {
      const result = await billing.recordUsage(input);
      balance -= input.amountUsd;
      return result;
    },
  };
  return { service: createSpaceWalletBilling({ billing, walletBilling, warn: (message) => warnings.push(message) }), debits, queries, warnings };
}

test("disabled wallets preserve personal billing without provider wallet calls", async () => {
  const fixture = setup(10, { enabled: false });
  await fixture.service.recordUsage(request);
  await fixture.service.recordUsage({ ...request, retryOnly: true });
  assert.deepEqual(fixture.debits.map((item) => item.userId), ["user", "user"]);
  assert.deepEqual(fixture.queries, []);
});

test("whole charges use the wallet only when sufficient", async () => {
  for (const [balance, payer] of [[0, "user"], [0.3, "user"], [0.5, spaceWalletCustomerId("space")]] as const) {
    const fixture = setup(balance);
    await fixture.service.recordUsage({ ...request, reason: "LLM usage provider/model" });
    assert.equal(fixture.debits.length, 1);
    assert.equal(fixture.debits[0]?.userId, payer);
    assert.equal(fixture.debits[0]?.amountUsd, 0.5);
    assert.equal(fixture.debits[0]?.operationId, request.operationId);
    assert.equal(fixture.debits[0]?.reason, payer === "user" ? "LLM usage provider/model" : "actor_user_id=user; LLM usage provider/model");
  }
  const fixture = setup(1);
  await fixture.service.recordUsage({ ...request, userId: "user; admin=1", reason: "x".repeat(1024) });
  const reason = fixture.debits[0]?.reason;
  assert.ok(reason);
  assert.ok(reason.startsWith("actor_user_id=user%3B%20admin%3D1; "));
  assert.equal(reason.length, 1024);
});

test("preview failures can fall back, debit failures cannot", async () => {
  const preview = setup(10, { previewFails: true });
  await preview.service.recordUsage(request);
  assert.equal(preview.debits[0]?.userId, "user");
  for (const balance of [0, 10]) {
    const fixture = setup(balance, { debitFails: true });
    assert.equal((await fixture.service.recordUsage(request)).status, "skipped");
    assert.equal((await fixture.service.recordUsage({ ...request, retryOnly: true })).status, "skipped");
    assert.equal(fixture.debits.length, 1);
    assert.ok(fixture.warnings.some((message) => message.includes("manual billing verification")));
  }
});

test("a pinned payer is charged without routing, and its debit failures stay retryable", async () => {
  const wallet = setup(0);
  await wallet.service.recordUsage({ ...request, payer: "space_wallet", retryOnly: true, reason: "Generation" });
  assert.equal(wallet.debits[0]?.userId, spaceWalletCustomerId("space"));
  assert.equal(wallet.debits[0]?.reason, "actor_user_id=user; Generation");
  assert.deepEqual(wallet.queries, []);

  const personal = setup(10, { debitFails: true });
  await assert.rejects(personal.service.recordUsage({ ...request, payer: "personal" }), /Debit response lost/);
  assert.equal(personal.debits[0]?.userId, "user");
});
