import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeGenerationQuota, refundGenerationQuota } from "./quota.js";

/** A quota ledger that, like billing, never refuses a consume: the uncovered part becomes overage. */
function ledger(balance: number, options: { failOverageReversal?: boolean; raceSpend?: number } = {}) {
  const calls: string[] = [];
  let available = balance;
  return {
    calls,
    get available() { return available; },
    billing: {
      async getQuotaStatus() {
        const seen = available;
        available -= options.raceSpend ?? 0;
        return { tokenType: "video_second", balance: seen, grants: [] };
      },
      async consumeQuota(input: { amount: number; operationId: string }) {
        calls.push(`consume ${input.operationId} ${input.amount}`);
        const covered = Math.min(Math.max(available, 0), input.amount);
        available -= input.amount;
        return { amount: input.amount, overage: input.amount - covered };
      },
      async reverseQuota(input: { amount: number; operationId: string }) {
        calls.push(`reverse ${input.operationId} ${input.amount}`);
        if (options.failOverageReversal && input.operationId.endsWith(":overage")) throw new Error("billing down");
        available += input.amount;
        return { amount: input.amount, overageCancelled: input.amount };
      },
    },
  };
}

const quota = { ruleKey: "daily-video", tokenType: "video_second", parameter: "duration" };
const draw = (fixture: ReturnType<typeof ledger>, requested: number) =>
  consumeGenerationQuota({ billing: fixture.billing, taskRunId: "t1", userId: "u", usageType: "generation.video", model: "h3", quota, requested });

test("quota covers what the balance holds and never leaves debt behind", async () => {
  const full = ledger(42);
  assert.equal((await draw(full, 10)).covered, 10);
  assert.equal(full.available, 32);

  const partial = ledger(6);
  assert.equal((await draw(partial, 10)).covered, 6);
  assert.deepEqual(partial.calls, ["consume generation-quota:t1 6"]);

  const empty = ledger(0);
  assert.equal((await draw(empty, 10)).covered, 0);
  assert.deepEqual(empty.calls, []);
});

test("a concurrent spend between the balance read and the draw is cancelled as overage", async () => {
  const raced = ledger(6, { raceSpend: 4 });
  assert.equal((await draw(raced, 10)).covered, 2);
  assert.equal(raced.available, 0);
  assert.deepEqual(raced.calls, ["consume generation-quota:t1 6", "reverse generation-quota:t1:overage 4"]);
});

test("a failed overage cancellation voids the whole draw before failing admission", async () => {
  const fixture = ledger(6, { raceSpend: 4, failOverageReversal: true });
  await assert.rejects(draw(fixture, 10), /billing down/);
  assert.equal(fixture.available, 2);
  assert.ok(fixture.calls.includes("reverse generation-quota:t1:void 6"));
});

test("refund returns only the covered units under a stable operation id", async () => {
  const fixture = ledger(6);
  const use = await draw(fixture, 10);
  await refundGenerationQuota({ billing: fixture.billing, taskRunId: "t1", userId: "u", quota: use, reason: "task_failed" });
  await refundGenerationQuota({ billing: fixture.billing, taskRunId: "t1", userId: "u", quota: { ...use, covered: 0 }, reason: "task_failed" });
  assert.equal(fixture.available, 6);
  assert.deepEqual(fixture.calls.at(-1), "reverse generation-quota:t1:refund 6");
});
