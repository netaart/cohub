import assert from "node:assert/strict";
import { test } from "node:test";
import { createDisabledBillingOperations, type BillingOperations, type SpaceWalletBillingOperations } from "@cohub/billing";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createGenerationBillingReservations } from "./index.js";

const DDL = `
CREATE SCHEMA v2;
CREATE TABLE v2.generation_billing_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_run_id uuid NOT NULL,
  user_id varchar(255) NOT NULL,
  space_id uuid,
  model varchar(255) NOT NULL,
  usage_type varchar(100) NOT NULL,
  payer_type varchar(20) NOT NULL,
  payer_id varchar(255) NOT NULL,
  reserve_usd numeric(18, 8) NOT NULL,
  actual_usd numeric(18, 8),
  discount_multiplier numeric(8, 5) DEFAULT '1' NOT NULL,
  reserve_operation_id varchar(255) NOT NULL,
  settle_operation_id varchar(255),
  reversal_operation_id varchar(255),
  status varchar(20) DEFAULT 'reserving' NOT NULL,
  reversal_receipt jsonb,
  last_error text,
  expires_at timestamp with time zone NOT NULL,
  settled_at timestamp with time zone,
  released_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE UNIQUE INDEX uq_task ON v2.generation_billing_reservations(task_run_id);
CREATE UNIQUE INDEX uq_reserve_operation ON v2.generation_billing_reservations(reserve_operation_id);
CREATE UNIQUE INDEX uq_settle_operation ON v2.generation_billing_reservations(settle_operation_id);
CREATE UNIQUE INDEX uq_reversal_operation ON v2.generation_billing_reservations(reversal_operation_id);
`;

function fakeBilling(initialBalance: number) {
  let balance = initialBalance;
  const consumptions = new Map<string, { amount: number; reversed: number }>();
  const reversals: number[] = [];
  const operations = {
    status: { provider: "talesofai", configured: true },
    async preflightUsage(input: { estimatedAmountUsd: number }) {
      return {
        allowed: balance >= input.estimatedAmountUsd,
        tokenType: "usd_micro_cent",
        estimatedAmountUsd: input.estimatedAmountUsd,
        availableBalance: balance,
        netBalance: balance,
        shortfall: Math.max(0, input.estimatedAmountUsd - balance),
      };
    },
    async recordUsage(input: { operationId: string; amountUsd: number }) {
      const existing = consumptions.get(input.operationId);
      if (existing) return { tokenType: "usd_micro_cent", amountUsd: input.amountUsd, status: "recorded" as const, response: null };
      const overage = balance < input.amountUsd;
      if (!overage) balance -= input.amountUsd;
      else balance = 0;
      consumptions.set(input.operationId, { amount: input.amountUsd, reversed: 0 });
      return { tokenType: "usd_micro_cent", amountUsd: input.amountUsd, status: overage ? "overage" as const : "recorded" as const, response: null };
    },
    async reverseUsage(input: { originalOperationId: string; amountUsd: number }) {
      const consumption = consumptions.get(input.originalOperationId);
      if (!consumption) throw new Error("missing consumption");
      const remaining = consumption.amount - consumption.reversed;
      const amount = Math.min(remaining, input.amountUsd);
      consumption.reversed += amount;
      balance += amount;
      reversals.push(amount);
      return {
        tokenType: "usd_micro_cent",
        amountUsd: amount,
        status: "reversed" as const,
        receipt: {
          reversalId: `rev-${reversals.length}`,
          originalOperationId: input.originalOperationId,
          operationId: `rev-op-${reversals.length}`,
          amountUsd: amount,
          openOverageCancelledUsd: 0,
          writtenOffMatchedUsd: 0,
          availableCreditReturnedUsd: amount,
          suppressedCreditReturnedUsd: 0,
          expiredCreditReturnedUsd: 0,
          closedSourceCreditReturnedUsd: 0,
          totalReversedUsd: consumption.reversed,
          remainingReversibleUsd: consumption.amount - consumption.reversed,
          decisionAt: new Date().toISOString(),
        },
      };
    },
    async getUsageConsumption(input: { operationId: string }) {
      const consumption = consumptions.get(input.operationId);
      if (!consumption) return null;
      return {
        originalOperationId: input.operationId,
        tokenType: "usd_micro_cent",
        originalAmountUsd: consumption.amount,
        totalReversedUsd: consumption.reversed,
        remainingReversibleUsd: consumption.amount - consumption.reversed,
        reversalStatus: consumption.reversed === 0 ? "not_reversed" as const : consumption.reversed >= consumption.amount ? "fully_reversed" as const : "partially_reversed" as const,
      };
    },
  } as unknown as BillingOperations;
  return { operations, reversals, balance: () => balance };
}

function disabledWallet(): SpaceWalletBillingOperations {
  return Object.assign(createDisabledBillingOperations("disabled for test"), { businessKey: null });
}

async function setup() {
  const engine = new PGlite();
  await engine.exec(DDL);
  const db = drizzle(engine) as unknown as PostgresJsDatabase<Record<string, unknown>>;
  const fake = fakeBilling(10);
  const service = createGenerationBillingReservations({ db, billing: fake.operations, walletBilling: disabledWallet() });
  return { engine, service, fake };
}

test("reserve, settle with refund, and duplicate settlement", async () => {
  const { engine, service, fake } = await setup();
  try {
    const taskRunId = "11111111-1111-4111-8111-111111111111";
    const reserved = await service.reserve({
      taskRunId,
      userId: "user",
      spaceId: null,
      model: "seedance-2-0",
      usageType: "generation.video",
      reserveUsd: 10,
      discountMultiplier: 1,
    });
    assert.equal(reserved.status, "held");
    assert.equal(fake.balance(), 0);

    const settled = await service.settle({ taskRunId, actualUsd: 6 });
    assert.equal(settled.status, "settled");
    assert.equal(fake.balance(), 4);
    assert.deepEqual(fake.reversals, [4]);

    await service.settle({ taskRunId, actualUsd: 6 });
    assert.deepEqual(fake.reversals, [4]);
  } finally {
    await engine.close();
  }
});

test("failed reservation releases the full reserve", async () => {
  const { engine, service, fake } = await setup();
  try {
    const taskRunId = "22222222-2222-4222-8222-222222222222";
    await service.reserve({
      taskRunId,
      userId: "user",
      spaceId: null,
      model: "seedance-2-0",
      usageType: "generation.video",
      reserveUsd: 10,
      discountMultiplier: 1,
    });
    await service.release({ taskRunId, reason: "task_failed" });
    assert.equal(fake.balance(), 10);
    assert.deepEqual(fake.reversals, [10]);
  } finally {
    await engine.close();
  }
});

test("insufficient balance is blocked before any consume", async () => {
  const { engine, service, fake } = await setup();
  try {
    const reserved = await service.reserve({
      taskRunId: "33333333-3333-4333-8333-333333333333",
      userId: "user",
      spaceId: null,
      model: "seedance-2-0",
      usageType: "generation.video",
      reserveUsd: 11,
      discountMultiplier: 1,
    });
    assert.equal(reserved.status, "blocked");
    assert.equal(fake.balance(), 10);
    assert.deepEqual(fake.reversals, []);
  } finally {
    await engine.close();
  }
});
