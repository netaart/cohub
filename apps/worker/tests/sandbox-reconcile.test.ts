import assert from "node:assert/strict";
import { test } from "node:test";
import { runDirectWorkspaceWrite, type SandboxReconcileDeps } from "../src/sandbox-reconcile.js";

function fence(dialable: boolean, events: string[], options: { reconcileFails?: boolean } = {}): SandboxReconcileDeps {
  return {
    async isSandboxDialable(spaceId) {
      events.push(`check:${spaceId}`);
      return dialable;
    },
    async reconcileSandbox(spaceId) {
      events.push(`reconcile:${spaceId}`);
      if (options.reconcileFails) throw new Error("agent unavailable");
    },
  };
}

test("a sandbox that is dialable once the write finishes is told to reconcile", async () => {
  const events: string[] = [];
  const result = await runDirectWorkspaceWrite("space-1", async () => {
    events.push("write");
    return 42;
  }, fence(true, events));
  assert.equal(result, 42);
  assert.deepEqual(events, ["write", "check:space-1", "reconcile:space-1"]);
});

test("no reconcile is sent while no sandbox is dialable", async () => {
  const events: string[] = [];
  await runDirectWorkspaceWrite("space-1", async () => {
    events.push("write");
  }, fence(false, events));
  assert.deepEqual(events, ["write", "check:space-1"]);
});

test("a failed write still reconciles what it wrote and keeps its own error", async () => {
  const events: string[] = [];
  await assert.rejects(runDirectWorkspaceWrite("space-1", async () => {
    events.push("partial write");
    throw new Error("restore failed");
  }, fence(true, events)), /restore failed/);
  assert.deepEqual(events, ["partial write", "check:space-1", "reconcile:space-1"]);
});

test("a failed reconcile does not fail a completed write", async () => {
  const events: string[] = [];
  const result = await runDirectWorkspaceWrite("space-1", async () => "done", fence(true, events, { reconcileFails: true }));
  assert.equal(result, "done");
  assert.deepEqual(events, ["check:space-1", "reconcile:space-1"]);
});
