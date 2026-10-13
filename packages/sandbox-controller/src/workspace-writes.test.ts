import assert from "node:assert/strict";
import { mock, test, type TestContext } from "node:test";
import {
  DIRECT_WRITE_LEASE_MS,
  DIRECT_WRITE_RENEW_MS,
  DIRECT_WRITE_SETTLE_MS,
  readWorkspaceWriteToken,
  runDirectWorkspaceWrite,
  type WorkspaceWriteStore,
} from "./workspace-writes.js";

/** Mirrors the SQL store on the mocked clock. */
function memoryStore() {
  const state = {
    gen: 0,
    settledAt: -1,
    recorded: false,
    writers: new Map<string, number>(),
    failing: false,
    holdDelay: null as Promise<void> | null,
  };
  const fail = () => {
    if (state.failing) throw new Error("db down");
  };
  const store: WorkspaceWriteStore = {
    async hold(_spaceId, writerId) {
      if (state.holdDelay) await state.holdDelay;
      fail();
      for (const [id, lease] of state.writers) if (lease < Date.now()) state.writers.delete(id);
      state.writers.set(writerId, Date.now() + DIRECT_WRITE_LEASE_MS);
      state.recorded = true;
      state.gen += 1;
      state.settledAt = Math.max(state.settledAt, Date.now());
    },
    async release(_spaceId, writerId) {
      fail();
      state.gen += 1;
      state.settledAt = Math.max(state.settledAt, Date.now() + DIRECT_WRITE_SETTLE_MS);
      state.writers.delete(writerId);
    },
    async read() {
      if (!state.recorded) return null;
      const running = [...state.writers.values()].some((lease) => lease > Date.now());
      return { gen: state.gen, settled: state.settledAt <= Date.now() && !running };
    },
  };
  return { store, state };
}
const logger = { error: () => undefined };
const token = (store: WorkspaceWriteStore) => readWorkspaceWriteToken(store, "space-1");

/** Starts a write that runs until the returned function is called. */
async function startWrite(store: WorkspaceWriteStore, log: { error(message: string): void } = logger) {
  let finish!: () => void;
  const done = runDirectWorkspaceWrite(store, "space-1", () => new Promise<void>((resolve) => {
    finish = resolve;
  }), log);
  await flush();
  return async () => {
    finish();
    await done;
  };
}

async function tick(t: TestContext, ms: number) {
  t.mock.timers.tick(ms);
  await flush();
}

async function flush() {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

test("searches see no token from a write's start until it settled after its end", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const { store } = memoryStore();
  assert.equal(await token(store), "space-1:0");
  const finish = await startWrite(store);
  // A writer that outlives its lease keeps renewing it.
  for (let elapsed = 0; elapsed < 2 * DIRECT_WRITE_LEASE_MS; elapsed += DIRECT_WRITE_RENEW_MS) {
    await tick(t, DIRECT_WRITE_RENEW_MS);
    assert.equal(await token(store), null, `token visible ${elapsed + DIRECT_WRITE_RENEW_MS} ms into the write`);
  }
  await finish();
  await tick(t, DIRECT_WRITE_SETTLE_MS - 1);
  assert.equal(await token(store), null);
  await tick(t, 1);
  assert.match((await token(store)) ?? "", /^space-1:\d+$/);
});

test("overlapping writers hold searches back until the last one settled", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const { store } = memoryStore();
  const finishLong = await startWrite(store);
  await runDirectWorkspaceWrite(store, "space-1", async () => undefined, logger);
  await tick(t, DIRECT_WRITE_SETTLE_MS);
  assert.equal(await token(store), null, "the long writer still runs");
  await finishLong();
  await tick(t, DIRECT_WRITE_SETTLE_MS - 1);
  assert.equal(await token(store), null);
  await tick(t, 1);
  assert.notEqual(await token(store), null);
});

test("a writer that cannot record its end holds searches back until its lease lapses", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const { store, state } = memoryStore();
  const errors: string[] = [];
  const finish = await startWrite(store, { error: (message) => errors.push(message) });
  await tick(t, DIRECT_WRITE_RENEW_MS);
  // The next renewal and the end record both fail; the database recovers.
  state.failing = true;
  await tick(t, DIRECT_WRITE_RENEW_MS);
  await tick(t, DIRECT_WRITE_RENEW_MS - 1);
  await finish();
  state.failing = false;
  assert.equal(errors.length, 2);
  const lastRenewal = DIRECT_WRITE_RENEW_MS;
  const ended = 3 * DIRECT_WRITE_RENEW_MS - 1;
  await tick(t, lastRenewal + DIRECT_WRITE_LEASE_MS - ended - 1);
  assert.equal(await token(store), null, "visible before the last lease lapsed");
  await tick(t, 2);
  assert.notEqual(await token(store), null);
});

test("a writer whose lease lapsed bumps the generation once a renewal lands", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const { store, state } = memoryStore();
  const finish = await startWrite(store);
  state.failing = true;
  await tick(t, DIRECT_WRITE_LEASE_MS + DIRECT_WRITE_RENEW_MS);
  const lapsed = await token(store);
  assert.notEqual(lapsed, null, "a lapsed lease no longer holds searches back");
  state.failing = false;
  await tick(t, DIRECT_WRITE_RENEW_MS);
  assert.equal(await token(store), null);
  await finish();
  await tick(t, DIRECT_WRITE_SETTLE_MS);
  const settled = await token(store);
  assert.ok(settled && settled !== lapsed, "a sandbox that rescanned during the lapse rescans again");
});

test("a renewal still running when the write ends cannot recreate the writer", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const { store, state } = memoryStore();
  const finish = await startWrite(store);
  let resume!: () => void;
  state.holdDelay = new Promise((resolve) => {
    resume = resolve;
  });
  await tick(t, DIRECT_WRITE_RENEW_MS);
  const ending = finish();
  await flush();
  state.holdDelay = null;
  resume();
  await ending;
  assert.equal(state.writers.size, 0);
  await tick(t, DIRECT_WRITE_SETTLE_MS);
  assert.notEqual(await token(store), null);
});

test("a write whose hold cannot be recorded never starts", async () => {
  const { store, state } = memoryStore();
  state.failing = true;
  const write = mock.fn(async () => undefined);
  await assert.rejects(runDirectWorkspaceWrite(store, "space-1", write, logger), /db down/);
  assert.equal(write.mock.callCount(), 0);
});

test("a failed write still records its end and keeps its own error", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const { store, state } = memoryStore();
  await assert.rejects(runDirectWorkspaceWrite(store, "space-1", async () => {
    throw new Error("disk full");
  }, logger), /disk full/);
  assert.equal(state.writers.size, 0);
  assert.equal(state.gen, 2);
});
