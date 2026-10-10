import assert from "node:assert/strict";
import { test } from "node:test";
import { readWorkspaceWriteToken, runDirectWorkspaceWrite, type WorkspaceWriteStore } from "./workspace-writes.js";

function store(events: string[], options: { failBump?: number } = {}): WorkspaceWriteStore {
  let bumps = 0;
  return {
    async bump(spaceId) {
      bumps += 1;
      events.push(`bump:${spaceId}`);
      if (options.failBump === bumps) throw new Error("db down");
    },
    async read() {
      return { epoch: "row-1", gen: bumps };
    },
  };
}
const logger = { error: () => undefined };

test("a direct write is bracketed by two generation bumps", async () => {
  const events: string[] = [];
  const result = await runDirectWorkspaceWrite(store(events), "space-1", async () => {
    events.push("write");
    return 42;
  }, logger);
  assert.equal(result, 42);
  assert.deepEqual(events, ["bump:space-1", "write", "bump:space-1"]);
});

test("a write that cannot be recorded never starts", async () => {
  const events: string[] = [];
  await assert.rejects(runDirectWorkspaceWrite(store(events, { failBump: 1 }), "space-1", async () => {
    events.push("write");
  }, logger), /db down/);
  assert.deepEqual(events, ["bump:space-1"]);
});

test("a failed write still records its end and keeps its own error", async () => {
  const events: string[] = [];
  await assert.rejects(runDirectWorkspaceWrite(store(events), "space-1", async () => {
    events.push("partial write");
    throw new Error("disk full");
  }, logger), /disk full/);
  assert.deepEqual(events, ["bump:space-1", "partial write", "bump:space-1"]);
});

test("a lost end bump does not fail a completed write", async () => {
  const errors: string[] = [];
  const result = await runDirectWorkspaceWrite(store([], { failBump: 2 }), "space-1", async () => "done", {
    error: (message) => errors.push(message),
  });
  assert.equal(result, "done");
  assert.equal(errors.length, 1);
});

test("write tokens name the sandbox row and its generation", async () => {
  assert.equal(await readWorkspaceWriteToken(store([]), "space-1"), "row-1:0");
  assert.equal(await readWorkspaceWriteToken({ bump: async () => undefined, read: async () => null }, "space-1"), null);
});
