import assert from "node:assert/strict";
import { test } from "node:test";
import { createDisabledBillingOperations, type BillingOperations, type SpaceWalletBillingOperations } from "@cohub/billing";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createGenerationBillingReservations, settledReservationBilling } from "./index.js";

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
  settle_overage boolean DEFAULT false NOT NULL,
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
CREATE TABLE v2.task_runs (
  id uuid PRIMARY KEY,
  status varchar(20) NOT NULL,
  result jsonb
);
`;

function fakeBilling(initialBalance: number) {
  let balance = initialBalance;
  const consumptions = new Map<string, { amount: number; reversed: number }>();
  const reversalsById = new Map<string, string>();
  const reversals: number[] = [];
  const consumes: string[] = [];
  const failNext = { reverse: 0, reverseAfterCommit: 0, partialReceipt: 0 };
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
      balance -= input.amountUsd;
      consumes.push(input.operationId);
      consumptions.set(input.operationId, { amount: input.amountUsd, reversed: 0 });
      return { tokenType: "usd_micro_cent", amountUsd: input.amountUsd, status: overage ? "overage" as const : "recorded" as const, response: null };
    },
    async reverseUsage(input: { originalOperationId: string; operationId: string; amountUsd: number; reason?: string }) {
      if (failNext.reverse > 0) {
        failNext.reverse -= 1;
        throw new Error("transport failure");
      }
      const consumption = consumptions.get(input.originalOperationId);
      if (!consumption) throw new Error("missing consumption");
      // Billing contract: an operation id must be replayed with identical values.
      const body = JSON.stringify([input.originalOperationId, input.amountUsd, input.reason]);
      const replayed = reversalsById.get(input.operationId);
      if (replayed !== undefined) {
        if (replayed !== body) throw new Error(`reversal ${input.operationId} replayed with different values`);
      } else {
        if (input.amountUsd > consumption.amount - consumption.reversed) throw new Error("reversal exceeds remaining");
        reversalsById.set(input.operationId, body);
        consumption.reversed += input.amountUsd;
        balance += input.amountUsd;
        reversals.push(input.amountUsd);
      }
      if (failNext.reverseAfterCommit > 0) {
        failNext.reverseAfterCommit -= 1;
        throw new Error("response lost");
      }
      return {
        tokenType: "usd_micro_cent",
        amountUsd: input.amountUsd,
        status: "reversed" as const,
        receipt: {
          reversalId: `rev-${input.operationId}`,
          originalOperationId: input.originalOperationId,
          operationId: input.operationId,
          amountUsd: failNext.partialReceipt-- > 0 ? input.amountUsd / 2 : input.amountUsd,
          openOverageCancelledUsd: 0,
          writtenOffMatchedUsd: 0,
          availableCreditReturnedUsd: input.amountUsd,
          suppressedCreditReturnedUsd: 0,
          expiredCreditReturnedUsd: 0,
          closedSourceCreditReturnedUsd: 0,
          totalReversedUsd: consumption.reversed,
          remainingReversibleUsd: consumption.amount - consumption.reversed,
          decisionAt: new Date().toISOString(),
        },
      };
    },
  } as unknown as BillingOperations;
  return { operations, reversals, consumes, failNext, balance: () => balance };
}

function disabledWallet(): SpaceWalletBillingOperations {
  return Object.assign(createDisabledBillingOperations("disabled for test"), { businessKey: null });
}

async function setup(balance = 10) {
  const engine = new PGlite();
  await engine.exec(DDL);
  const db = drizzle(engine) as unknown as PostgresJsDatabase<Record<string, unknown>>;
  const fake = fakeBilling(balance);
  const notified: string[] = [];
  const service = createGenerationBillingReservations({
    db,
    billing: fake.operations,
    walletBilling: disabledWallet(),
    onReconcileSettled: async (reservation) => { notified.push(reservation.taskRunId); },
  });
  return { engine, service, fake, notified };
}

const reserveInput = (taskRunId: string, reserveUsd = 10) => ({
  taskRunId,
  userId: "user",
  spaceId: null,
  model: "seedance-2-0",
  usageType: "generation.video",
  reserveUsd,
  discountMultiplier: 1,
});

const taskId = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

async function withSetup(balance: number, run: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const ctx = await setup(balance);
  try {
    await run(ctx);
  } finally {
    await ctx.engine.close();
  }
}

test("reserve, settle with refund, and duplicate settlement", () => withSetup(10, async ({ service, fake, notified }) => {
  assert.equal((await service.reserve(reserveInput(taskId(1)))).status, "held");
  assert.equal(fake.balance(), 0);

  assert.equal((await service.settle({ taskRunId: taskId(1), actualUsd: 6 })).status, "settled");
  assert.equal(fake.balance(), 4);

  await service.settle({ taskRunId: taskId(1), actualUsd: 6 });
  assert.deepEqual(fake.reversals, [4]);
  assert.deepEqual(notified, []);
}));

test("settlement charges the shortfall and keeps the overage outcome on replay", () => withSetup(10, async ({ service, fake }) => {
  await service.reserve(reserveInput(taskId(1)));
  const settled = await service.settle({ taskRunId: taskId(1), actualUsd: 12.5 });
  assert.equal(settled.status === "settled" && settled.overage, true);
  const replayed = await service.settle({ taskRunId: taskId(1), actualUsd: 12.5 });
  assert.equal(replayed.status === "settled" && replayed.overage, true);
  assert.equal(fake.balance(), -2.5);
}));

test("submit-side cleanup cannot release a reservation a worker has claimed", () => withSetup(10, async ({ service, fake }) => {
  await service.reserve(reserveInput(taskId(1)));
  assert.equal((await service.claim(taskId(1)))?.status, "running");
  assert.equal((await service.release({ taskRunId: taskId(1), reason: "enqueue_failed", unclaimedOnly: true }))?.status, "running");
  assert.equal((await service.settle({ taskRunId: taskId(1), actualUsd: 6 })).status, "settled");
  assert.deepEqual(fake.reversals, [4]);
}));

test("a lost refund response replays identical values through reconcile", () => withSetup(10, async ({ engine, service, fake, notified }) => {
  await service.reserve(reserveInput(taskId(1)));
  fake.failNext.reverseAfterCommit = 1;
  assert.equal((await service.settle({ taskRunId: taskId(1), actualUsd: 6 })).status, "pending");

  const [row] = (await engine.query<{ id: string }>("select id from v2.generation_billing_reservations")).rows;
  await engine.query("update v2.generation_billing_reservations set updated_at = now() - interval '1 hour' where id = $1", [row?.id]);
  assert.deepEqual(await service.reconcile(), { processed: 1 });

  const retried = await service.settle({ taskRunId: taskId(1), actualUsd: 7 });
  assert.equal(retried.status, "settled");
  assert.equal(retried.status === "settled" && settledReservationBilling(retried.reservation).amountUsd, 6);
  assert.deepEqual(fake.reversals, [4]);
  assert.equal(fake.balance(), 4);
  assert.deepEqual(notified, [taskId(1)]);
}));

test("a short reversal receipt keeps the settlement retryable", () => withSetup(10, async ({ service, fake }) => {
  await service.reserve(reserveInput(taskId(1)));
  fake.failNext.partialReceipt = 1;
  assert.equal((await service.settle({ taskRunId: taskId(1), actualUsd: 6 })).status, "pending");
  assert.equal((await service.getReservation(taskId(1)))?.status, "settling");
}));

test("recovery fences an in-flight reserve debit before releasing it", () => withSetup(10, async ({ engine, service, fake }) => {
  await engine.query(`insert into v2.generation_billing_reservations
    (task_run_id, user_id, model, usage_type, payer_type, payer_id, reserve_usd, reserve_operation_id, expires_at, updated_at)
    values ($1, 'user', 'seedance-2-0', 'generation.video', 'personal', 'user', 10, $2, now() + interval '1 day', now() - interval '20 minutes')`,
  [taskId(1), `generation:reserve:${taskId(1)}`]);
  assert.deepEqual(await service.reconcile(), { processed: 1 });
  assert.equal((await service.getReservation(taskId(1)))?.status, "released");

  // The stalled original caller's debit lands late under the same operation id.
  await fake.operations.recordUsage({ userId: "user", amountUsd: 10, sourceId: taskId(1), operationId: `generation:reserve:${taskId(1)}`, usageType: "generation.video" });
  assert.deepEqual(fake.reversals, [10]);
  assert.equal(fake.balance(), 10);
}));

test("release never undoes a settlement in progress", () => withSetup(10, async ({ service, fake }) => {
  await service.reserve(reserveInput(taskId(1)));
  fake.failNext.reverse = 1;
  assert.equal((await service.settle({ taskRunId: taskId(1), actualUsd: 6 })).status, "pending");

  assert.equal((await service.release({ taskRunId: taskId(1), reason: "task_failed" }))?.status, "settling");
  assert.equal((await service.settle({ taskRunId: taskId(1), actualUsd: 6 })).status, "settled");
  assert.deepEqual(fake.reversals, [4]);
}));

test("failed reservation releases the full reserve once", () => withSetup(10, async ({ service, fake }) => {
  await service.reserve(reserveInput(taskId(1)));
  fake.failNext.reverseAfterCommit = 1;
  await assert.rejects(service.release({ taskRunId: taskId(1), reason: "task_failed" }));
  assert.equal((await service.release({ taskRunId: taskId(1), reason: "task_failed" }))?.status, "released");
  assert.equal((await service.settle({ taskRunId: taskId(1), actualUsd: 6 })).status, "released");
  assert.deepEqual(fake.reversals, [10]);
  assert.equal(fake.balance(), 10);
}));

test("insufficient balance is blocked before any consume", () => withSetup(10, async ({ service, fake }) => {
  assert.equal((await service.reserve(reserveInput(taskId(1), 11))).status, "blocked");
  assert.deepEqual(fake.consumes, []);
}));

test("concurrent reserves never leave the payer overdrawn", () => withSetup(10, async ({ service, fake }) => {
  const results = await Promise.all([service.reserve(reserveInput(taskId(1))), service.reserve(reserveInput(taskId(2)))]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["blocked", "held"]);
  assert.equal(fake.balance(), 0);
}));

test("reconcile settles finished tasks and keeps running holds", () => withSetup(1_000, async ({ engine, service, fake }) => {
  for (let n = 1; n <= 60; n += 1) await service.reserve(reserveInput(taskId(n)));
  for (let n = 1; n <= 58; n += 1) await engine.query("insert into v2.task_runs (id, status) values ($1, 'running')", [taskId(n)]);
  await engine.query("insert into v2.task_runs (id, status, result) values ($1, 'completed', $2)", [taskId(59), { cost: 3 }]);
  await engine.query("insert into v2.task_runs (id, status) values ($1, 'failed')", [taskId(60)]);

  assert.deepEqual(await service.reconcile(), { processed: 2 });
  assert.equal((await service.getReservation(taskId(59)))?.status, "settled");
  assert.equal((await service.getReservation(taskId(60)))?.status, "released");
  assert.equal((await service.getReservation(taskId(1)))?.status, "held");
  assert.equal(fake.balance(), 1_000 - 58 * 10 - 3);

  await engine.query("update v2.generation_billing_reservations set expires_at = now() - interval '1 minute' where task_run_id = $1", [taskId(1)]);
  assert.deepEqual(await service.reconcile(), { processed: 1 });
  assert.equal((await service.getReservation(taskId(1)))?.status, "released");
}));
