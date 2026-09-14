import assert from "node:assert/strict";
import { test } from "node:test";
import { BillingUsageGateUnavailableError } from "../src/errors.js";
import { createBillingUsageGate, type BillingUsageGateInput } from "../src/usage-gate.js";

const gateInput = (usageKind: BillingUsageGateInput["usageKind"]): BillingUsageGateInput => ({
  userId: "user-1",
  usageKind,
  source: "generation_task",
});

const gateWithBalance = (netUsd: number) => createBillingUsageGate({
  operations: {
    getCreditStatus: async () => ({ netUsd, groups: [] }),
  },
});

test("disabled billing bypasses the balance gate", async () => {
  let requested = false;
  const gate = createBillingUsageGate({
    operations: {
      status: { provider: "disabled", configured: false },
      getCreditStatus: async () => {
        requested = true;
        throw new Error("disabled billing must not be queried");
      },
    },
  });

  assert.deepEqual(
    await gate.evaluate(gateInput("generation.image")),
    { status: "allowed", balanceState: "zero", netUsd: 0 },
  );
  assert.equal(requested, false);
});

test("video generation requires at least $1.01", async () => {
  const blocked = await gateWithBalance(1).evaluate(gateInput("generation.video"));
  assert.equal(blocked.status, "blocked");
  if (blocked.status !== "blocked") return;
  assert.equal(blocked.balanceState, "positive");
  assert.equal("minimumBalanceUsd" in blocked && blocked.minimumBalanceUsd, 1.01);
  assert.equal(blocked.conversion.reason, "minimum_balance_not_met");
  assert.equal(blocked.conversion.title, "Insufficient balance");
  assert.equal(blocked.conversion.message, "Video generation requires a balance of at least $1.01.");

  const allowed = await gateWithBalance(1.01).evaluate(gateInput("generation.video"));
  assert.equal(allowed.status, "allowed");
});

test("only a positive balance allows usage", async () => {
  const positive = await gateWithBalance(0.00000001).evaluate(gateInput("generation.image"));
  assert.deepEqual(positive, { status: "allowed", balanceState: "positive", netUsd: 0.00000001 });

  for (const netUsd of [0, -0.00000001, -1]) {
    const decision = await gateWithBalance(netUsd).evaluate(gateInput("generation.image"));
    assert.equal(decision.status, "blocked");
    if (decision.status !== "blocked") continue;
    assert.equal(decision.balanceState, netUsd === 0 ? "zero" : "negative");
    assert.equal(decision.netUsd, netUsd);
    assert.equal("hardNegativeLimitUsd" in decision && decision.hardNegativeLimitUsd, 0);
    assert.equal(decision.conversion.reason, "balance_not_positive");
    assert.equal(decision.conversion.message, "A positive balance is required to continue.");
  }
});

test("video balance lookup failures are fail-closed", async () => {
  const error = new Error("billing unavailable");
  const gate = createBillingUsageGate({
    operations: {
      getCreditStatus: async () => { throw error; },
    },
  });

  await assert.rejects(
    gate.evaluate(gateInput("generation.video")),
    (cause: unknown) => cause instanceof BillingUsageGateUnavailableError && cause.cause === error,
  );
});

test("other balance lookup failures preserve fail-open behavior", async () => {
  const gate = createBillingUsageGate({
    operations: {
      getCreditStatus: async () => { throw new Error("billing unavailable"); },
    },
  });

  assert.deepEqual(
    await gate.evaluate(gateInput("generation.image")),
    { status: "allowed", balanceState: "zero", netUsd: 0 },
  );
});

test("non-finite balances follow the configured evaluation error policy", async () => {
  for (const netUsd of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const errors: unknown[] = [];
    const gate = createBillingUsageGate({
      operations: {
        getCreditStatus: async () => ({ netUsd, groups: [] }),
      },
      onEvaluationError: (error) => errors.push(error),
    });

    await assert.rejects(
      gate.evaluate(gateInput("generation.video")),
      (cause: unknown) => cause instanceof BillingUsageGateUnavailableError && cause.cause === errors[0],
    );
    assert.deepEqual(
      await gate.evaluate(gateInput("generation.image")),
      { status: "allowed", balanceState: "zero", netUsd: 0 },
    );
    assert.equal(errors.length, 2);
    for (const error of errors) {
      assert.match(String(error), /non-finite net balance/);
    }
  }
});
