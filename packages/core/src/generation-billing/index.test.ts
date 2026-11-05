import assert from "node:assert/strict";
import { test } from "node:test";
import type { BillingOperations, SpaceWalletBillingOperations } from "@cohub/billing";
import { createGenerationReserveHolds, type GenerationReserveRedis } from "./index.js";

// Mirrors the Lua scripts: one hash per payer of taskRunId -> [amountUnits, expiresAtMs].
function fakeRedis(): GenerationReserveRedis {
  const hashes = new Map<string, Map<string, [number, number]>>();
  return {
    async eval(script, _keys, ...args) {
      const [key = "", field = "", ...rest] = args.map(String);
      const hash = hashes.get(key) ?? new Map<string, [number, number]>();
      hashes.set(key, hash);
      if (script.includes("HGETALL")) {
        const [amount = 0, balance = 0, now = 0, expiresAt = 0] = rest.map(Number);
        let total = 0;
        for (const [id, [held, until]] of hash) {
          if (until <= now) hash.delete(id);
          else if (id !== field) total += held;
        }
        if (total + amount > balance) return [0, total];
        hash.set(field, [amount, expiresAt]);
        return [1, total];
      }
      return hash.delete(field) ? 1 : 0;
    },
  };
}

function payer(netBalance: number) {
  return {
    status: { provider: "talesofai", configured: true },
    businessKey: "wallet",
    async getCreditStatus() {
      return { netUsd: netBalance, globalAvailableUsd: 0, groups: [] };
    },
    async preflightUsage() {
      return { netBalance, availableBalance: netBalance };
    },
  };
}

const request = (n: number, spaceId: string | null = "space") => ({
  taskRunId: `task-${n}`,
  userId: "user",
  spaceId,
  model: "seedance-2-0",
  usageType: "generation.video",
  amountUsd: 15,
});

test("holds must fit on top of live holds, Space wallet first", async () => {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const holds = createGenerationReserveHolds({
    redis: fakeRedis(),
    billing: payer(20) as unknown as BillingOperations,
    walletBilling: payer(20) as unknown as SpaceWalletBillingOperations,
    info: (message, context) => logs.push([message, context]),
  });

  const first = await holds.hold(request(1));
  assert.equal(first.status === "held" && first.hold.payer.type, "space_wallet");
  const second = await holds.hold(request(2));
  assert.equal(second.status === "held" && second.hold.payer.type, "personal");

  const third = await holds.hold(request(3));
  assert.equal(third.status, "blocked");
  assert.match(third.status === "blocked" ? third.error.message : "", /Available balance is \$5\.00; add \$10\.00/);
  assert.deepEqual(logs.map(([message, context]) => [message, context.payerType ?? context.shortfallUsd]), [
    ["[GenerationReserve] held", "space_wallet"],
    ["[GenerationReserve] held", "personal"],
    ["[GenerationReserve] blocked", 10],
  ]);
});

test("a released hold frees the balance at once", async () => {
  const holds = createGenerationReserveHolds({
    redis: fakeRedis(),
    billing: payer(20) as unknown as BillingOperations,
    walletBilling: payer(0) as unknown as SpaceWalletBillingOperations,
  });
  const held = await holds.hold(request(1, null));
  assert.equal(held.status, "held");
  if (held.status !== "held") return;

  assert.equal((await holds.hold(request(2, null))).status, "blocked");
  await holds.release("task-1", held.hold.payer, "charged");
  assert.equal((await holds.hold(request(2, null))).status, "held");
});

test("a hold script that errors drops any hold it may have written before rethrowing", async () => {
  const calls: string[] = [];
  const holds = createGenerationReserveHolds({
    redis: {
      async eval(script) {
        calls.push(script.includes("HGETALL") ? "hold" : "drop");
        if (script.includes("HGETALL")) throw new Error("Command timed out");
        return 0;
      },
    },
    billing: payer(20) as unknown as BillingOperations,
    walletBilling: payer(0) as unknown as SpaceWalletBillingOperations,
  });
  await assert.rejects(holds.hold(request(1, null)), /timed out/);
  assert.deepEqual(calls, ["hold", "drop"]);
});
