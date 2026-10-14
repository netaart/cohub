import assert from "node:assert/strict";
import test from "node:test";
import type { NativeTurnProgress } from "@neta-art/cohub";
import { LiveProgress } from "../src/runtime/native/translate.js";

const settle = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
const message = (text: string) => ({ content: [{ type: "text" as const, text }], provider: null, model: null });

for (const outcome of ["rejected", "resync", "error", "throw"] as const) {
  test(`live progress retries ${outcome} without another harness event`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const sent: NativeTurnProgress[] = [];
    const errors: unknown[] = [];
    const progress = new LiveProgress((update) => {
      sent.push(structuredClone(update));
      if (sent.length > 1) return Promise.resolve({ accepted: true });
      if (outcome === "throw") throw new Error("Transport unavailable");
      if (outcome === "error") return Promise.reject(new Error("Transport unavailable"));
      return Promise.resolve(outcome === "rejected" ? { accepted: false } : { accepted: true, resync: true });
    }, 20, (error) => errors.push(error));
    context.after(() => progress.dispose());
    progress.replace([message("first"), message("latest")]);
    context.mock.timers.tick(20);
    await settle();
    assert.equal(sent.length, 1);
    context.mock.timers.tick(100);
    await settle();
    assert.equal(sent.length, 1, "a failed send must not create a hot retry loop");
    context.mock.timers.tick(30_000);
    await settle();
    assert.equal(sent.length, 2, "the last snapshot retries even with no further events");
    assert.equal(sent[1]?.from, 0);
    assert.deepEqual(sent[1]?.messages, [message("first"), message("latest")]);
    assert.ok((sent[1]?.revision ?? 0) > (sent[0]?.revision ?? 0));
    assert.equal(errors.length, 1, "refusals and transport failures remain diagnosable");
    progress.apply({ type: "text.delta", ordinal: 1, index: 0, kind: "text", delta: " update" });
    context.mock.timers.tick(20);
    await settle();
    assert.equal(sent[2]?.from, 1, "a successful retry restores incremental sends");
    assert.deepEqual(sent[2]?.messages, [message("latest update")]);
  });
}

test("live progress retains edits made during a failed send and cancels retries on disposal", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sent: NativeTurnProgress[] = [];
  let reject!: (error: Error) => void;
  const progress = new LiveProgress((update) => {
    sent.push(structuredClone(update));
    return new Promise((_resolve, fail) => { reject = fail; });
  }, 20, () => {});
  progress.replace([message("initial")]);
  context.mock.timers.tick(20);
  progress.apply({ type: "text.delta", ordinal: 0, index: 0, kind: "text", delta: " changed" });
  progress.replace([message("initial changed"), message("new message")]);
  reject(new Error("Disconnected"));
  await settle();
  context.mock.timers.tick(30_000);
  await settle();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]?.messages, [message("initial changed"), message("new message")]);
  reject(new Error("Still disconnected"));
  await settle();
  progress.dispose();
  context.mock.timers.tick(60_000);
  await settle();
  assert.equal(sent.length, 2, "disposed previews never send another retry");
});

test("live progress does not poll a turn that has not been registered", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  let registered = false;
  const sent: NativeTurnProgress[] = [];
  const progress = new LiveProgress((update) => {
    calls += 1;
    if (!registered) return null;
    sent.push(structuredClone(update));
    return Promise.resolve({ accepted: true });
  }, 20);
  context.after(() => progress.dispose());
  progress.replace([message("waiting")]);
  context.mock.timers.tick(20);
  await settle();
  context.mock.timers.tick(60_000);
  await settle();
  assert.equal(calls, 1);
  registered = true;
  progress.apply({ type: "text.delta", ordinal: 0, index: 0, kind: "text", delta: " ready" });
  context.mock.timers.tick(20);
  await settle();
  assert.equal(sent[0]?.from, 0);
  assert.deepEqual(sent[0]?.messages, [message("waiting ready")]);
});

test("repeated failures back off with a bounded delay", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const progress = new LiveProgress(() => {
    calls += 1;
    return Promise.reject(new Error("Disconnected"));
  }, 0, () => {});
  context.after(() => progress.dispose());
  progress.replace([message("latest")]);
  context.mock.timers.tick(0);
  await settle();
  assert.equal(calls, 1);
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const previous = calls;
    context.mock.timers.tick(delay - 1);
    await settle();
    assert.equal(calls, previous, "a retry must wait for the backoff interval");
    context.mock.timers.tick(1);
    await settle();
    assert.equal(calls, previous + 1);
  }
});

test("an acknowledged send does not consume changes made while it was pending", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sent: NativeTurnProgress[] = [];
  let resolve!: (value: { accepted: true }) => void;
  const progress = new LiveProgress((update) => {
    sent.push(update);
    return new Promise((done) => { resolve = done; });
  }, 20);
  context.after(() => progress.dispose());
  progress.replace([message("first"), message("second")]);
  context.mock.timers.tick(20);
  progress.apply({ type: "text.delta", ordinal: 1, index: 0, kind: "text", delta: " changed" });
  assert.deepEqual(sent[0]?.messages, [message("first"), message("second")], "the pending request keeps its own snapshot");
  resolve({ accepted: true });
  await settle();
  context.mock.timers.tick(20);
  await settle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.from, 1);
  assert.deepEqual(sent[1]?.messages, [message("second changed")]);
  progress.dispose();
  resolve({ accepted: true });
  await settle();
  context.mock.timers.tick(60_000);
  assert.equal(sent.length, 2);
});
