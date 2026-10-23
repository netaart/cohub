import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardFrameClock } from "../../src/board/stage/frame-budget.js";
import { boardDeviceBudget, boardDeviceTier } from "../../src/board/stage/device.js";

test("frame budget follows measured cost and backs off from dropped frames", () => {
  let now = 0;
  const clock = createBoardFrameClock(() => now);
  const frame = (msPerUnit: number, gap = 16, moving = false) => {
    now += gap;
    clock.begin(now, { moving, chained: true });
    const allowed = clock.allow("materialize");
    clock.spend("materialize", allowed, allowed * msPerUnit);
    return allowed;
  };
  for (let index = 0; index < 12; index += 1) frame(2);
  assert.equal(frame(2), 6, "a slow device keeps an eighth of the batch");
  for (let index = 0; index < 20; index += 1) frame(0.01);
  const fast = frame(0.01);
  assert.ok(fast > 200, "a fast device does far more per frame");
  assert.ok(frame(0.01, 60, true) <= fast / 2, "a dropped frame while moving halves the work");
});

test("device tiers follow what the browser reveals", () => {
  assert.equal(boardDeviceTier({ phone: true }), "low");
  assert.equal(boardDeviceTier({}), "standard");
  assert.equal(boardDeviceTier({ memory: 4, cores: 4 }), "low");
  assert.equal(boardDeviceTier({ memory: 8, cores: 12 }), "high");
  assert.equal(boardDeviceBudget({ memory: 8, cores: 12, saveData: true }).prefetch, 0);
});
