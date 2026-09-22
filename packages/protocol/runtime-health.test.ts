import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeWorkspaceStatus } from "./src/runtime/index.js";

test("file-bridge readiness requires the current Runtime identity and a fresh lease", () => {
  const runtimeId = crypto.randomUUID();
  const now = Date.now();
  const receipt = { runtimeId, connectionId: crypto.randomUUID(), observedAt: new Date(now).toISOString() };
  const read = (patch = {}) => runtimeWorkspaceStatus(runtimeId, JSON.stringify({ ...receipt, ...patch }), now);
  assert.equal(read().online, true);
  assert.equal(read({ runtimeId: crypto.randomUUID() }).online, false);
  assert.equal(read({ observedAt: new Date(now - 60_000).toISOString() }).online, false);
  assert.equal(read({ observedAt: new Date(now + 60_000).toISOString() }).online, false);
  assert.equal(read({ connectionId: "invalid" }).online, false);
  assert.equal(runtimeWorkspaceStatus(null, JSON.stringify(receipt), now).online, false);
  for (const raw of [null, "{", "null", "{}", "42"]) assert.equal(runtimeWorkspaceStatus(runtimeId, raw, now).online, false);
});
