import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { nativeIngestTurnSchema, type ContentBlock } from "@neta-art/cohub";
import { nativeStableId } from "../src/runtime/native/identity.js";
import { readRegistration, restoreRegistration } from "../src/runtime/native/registration.js";
import { nativeWebSocketTransport } from "../src/runtime/native/transport.js";
import type { SessionTurnProjectionClient } from "../src/runtime/turn-projection.js";

const at = "2026-01-01T00:00:00.000Z";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prompt = (text: string): ContentBlock[] => [{ type: "text", text }];
function fixture(parent: "none" | "same" | "branch" = "none", imported = false, content = prompt("registered")) {
  const turnId = randomUUID(), spaceId = randomUUID(), parentTurnId = parent === "none" ? null : randomUUID();
  const branchSessionId = nativeStableId(JSON.stringify([turnId, "branch"]));
  const parentSessionId = randomUUID(), sessionId = parent === "same" ? parentSessionId : branchSessionId;
  const request = nativeIngestTurnSchema.parse({ turnId, parentTurnId, userContent: content, startedAt: at, ...(imported ? { origin: "local_import" } : {}), result: null });
  const expected = { spaceId, sessionId, turnId, harness: "codex" as const, nativeSessionId: "native", parentTurnId, startedAt: at, userContent: request.userContent, ...(request.origin ? { origin: request.origin } : {}) };
  const identity = { turnId, sessionId: parentTurnId ? parentSessionId : null, parentTurnId, branchSessionId, harness: "codex", nativeSessionId: "native", userContent: request.userContent, startedAt: at, ...(request.origin ? { origin: request.origin } : {}) };
  const receipt = { version: 1, spaceId, nativeSessionId: "native", parentTurnId, requestDigest: digest(identity), ...(request.origin ? { origin: request.origin, originalStartedAt: at } : {}) };
  const snapshot = {
    turn: { id: turnId, sessionId, sourceSessionId: sessionId, sourceTurnId: turnId, startedAt: at, userContent: structuredClone(request.userContent), meta: { source: "native_client", harness: "codex", nativeSync: receipt } },
    parent: parentTurnId ? { id: parentTurnId, sessionId, sourceSessionId: parentSessionId, sourceTurnId: parentTurnId } : null,
  };
  return { expected, snapshot, receipt };
}

test("unchanged input keeps its registered bytes when storage sanitized text or reordered arbitrary keys", () => {
  const cases: [ContentBlock[], ContentBlock[]][] = [
    [prompt("a\u0000b"), prompt("ab")],
    [prompt("a\ud800b"), prompt("a\uFFFDb")],
    [[{ type: "text", text: "hello", _meta: { b: 1, a: 2 } }], [{ text: "hello", _meta: { a: 2, b: 1 }, type: "text" }]],
    [[{ type: "tool_use", id: "call", name: "tool", input: { b: { z: 1, a: 2 }, a: 3 } }], [{ type: "tool_use", id: "call", name: "tool", input: { a: 3, b: { a: 2, z: 1 } } }]],
  ];
  for (const [original, stored] of cases) {
    const { expected, snapshot } = fixture("none", false, original);
    snapshot.turn.userContent = stored;
    const before = structuredClone(snapshot);
    assert.deepEqual(restoreRegistration(snapshot, expected), { userContent: original, diagnostic: null });
    assert.deepEqual(snapshot, before, "persisted prompt and receipt remain unchanged");
  }
});

test("changed prompts restore only a verified registration for root, append and fork histories", () => {
  for (const parent of ["none", "same", "branch"] as const) {
    for (const imported of [false, true]) {
      const { expected, snapshot, receipt } = fixture(parent, imported);
      expected.userContent = prompt("parsed initial prompt");
      snapshot.turn.userContent = [{ text: "registered", type: "text" }];
      const before = structuredClone(snapshot), restored = restoreRegistration(snapshot, expected);
      assert.deepEqual(restored.userContent, prompt("registered"));
      assert.equal(restored.diagnostic?.requestDigest, receipt.requestDigest);
      assert.equal(restored.diagnostic?.localSha256, digest(expected.userContent));
      assert.equal(restored.diagnostic?.registeredSha256, digest(prompt("registered")));
      assert.deepEqual(snapshot, before);
    }
  }
});

test("ordinary unchanged input is schema-normalized exactly as the server request", () => {
  const { expected, snapshot } = fixture();
  expected.userContent = [{ text: "registered", type: "text" }];
  assert.deepEqual(restoreRegistration(snapshot, expected), { userContent: prompt("registered"), diagnostic: null });
});

test("identity changes, damaged receipts and unrecoverable storage ordering fail explicitly", () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    ({ receipt }) => { receipt.spaceId = randomUUID(); },
    ({ receipt }) => { receipt.version = 2; },
    ({ receipt }) => { receipt.nativeSessionId = "other"; },
    ({ receipt }) => { receipt.parentTurnId = randomUUID(); },
    ({ receipt }) => { receipt.requestDigest = "0".repeat(64); },
    ({ receipt }) => { receipt.originalStartedAt = "2026-01-02T00:00:00.000Z"; },
    ({ receipt }) => { delete receipt.origin; },
    ({ snapshot }) => { snapshot.turn.meta.source = "other"; },
    ({ snapshot }) => { snapshot.turn.meta.harness = "pi"; },
    ({ snapshot }) => { snapshot.turn.sourceSessionId = randomUUID(); },
    ({ snapshot }) => { snapshot.turn.sourceTurnId = randomUUID(); },
    ({ snapshot }) => { assert(snapshot.parent); snapshot.parent.sourceTurnId = randomUUID(); },
    ({ snapshot }) => { assert(snapshot.parent); snapshot.parent.sourceSessionId = randomUUID(); },
  ];
  for (const mutate of mutations) {
    const f = fixture("branch", true); mutate(f);
    assert.throws(() => restoreRegistration(f.snapshot, f.expected), /registration (identity|digest) mismatch/i);
  }
  const { expected, snapshot } = fixture("none", false, [{ type: "text", text: "registered", _meta: { b: 1, a: 2 } }]);
  expected.userContent = prompt("parsed initial prompt");
  snapshot.turn.userContent = [{ type: "text", text: "registered", _meta: { a: 2, b: 1 } }];
  assert.throws(() => restoreRegistration(snapshot, expected), /registration digest mismatch/i);
});

test("invalid content and missing required records are not repaired from another candidate", () => {
  const { expected, snapshot } = fixture();
  for (const broken of [
    { ...snapshot, turn: null },
    { ...snapshot, turn: { ...snapshot.turn, meta: { nativeSync: [] } } },
    { ...snapshot, turn: { ...snapshot.turn, startedAt: "2026-01-02T00:00:00.000Z" } },
    { ...snapshot, turn: { ...snapshot.turn, userContent: undefined } },
    { ...snapshot, turn: { ...snapshot.turn, userContent: [{ type: "text", text: 1 }] } },
    { ...snapshot, parent: { id: randomUUID() } },
  ]) assert.throws(() => restoreRegistration(broken, expected));
  assert.throws(() => restoreRegistration(snapshot, { ...expected, userContent: [{ type: "text", text: null as unknown as string }] }));
  const child = fixture("same");
  assert.throws(() => restoreRegistration({ ...child.snapshot, parent: null }, child.expected), /identity mismatch/);
});

test("registration reads the visible parent in the owning session and propagates read failures", async () => {
  const { expected, snapshot } = fixture("branch"), calls: Array<[string, string, unknown]> = [];
  const failure = new Error("registration read unavailable");
  let failed = false;
  const source = { session: (sessionId: string) => ({ turns: { get: async (turnId: string, options: unknown) => {
    calls.push([sessionId, turnId, options]);
    if (failed) throw failure;
    return { turn: turnId === expected.turnId ? snapshot.turn : snapshot.parent };
  } } }) } as unknown as SessionTurnProjectionClient;
  const transport = nativeWebSocketTransport(async () => { throw new Error("Registration must use the scoped session client"); }, (sessionId, turnId, options) => readRegistration(source, sessionId, turnId, options));
  const registration = transport.registration; assert(registration);
  const options = { signal: new AbortController().signal };
  assert.deepEqual(await registration(expected.sessionId, expected.turnId, options), snapshot);
  assert.deepEqual(calls.map(([sessionId, turnId]) => [sessionId, turnId]), [[expected.sessionId, expected.turnId], [expected.sessionId, expected.parentTurnId]]);
  failed = true;
  await assert.rejects(registration(expected.sessionId, expected.turnId, options), error => error === failure);
});

test("registration reads share a deadline and propagate caller cancellation", async (context) => {
  const { expected, snapshot } = fixture("branch"), signals: AbortSignal[] = [];
  const deadline = new AbortController(), caller = new AbortController();
  const timeout = context.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 30_000); return deadline.signal; });
  const source = { session: () => ({ turns: { get: async (turnId: string, options?: { signal?: AbortSignal }) => {
    assert(options?.signal); signals.push(options.signal);
    return { turn: turnId === expected.turnId ? snapshot.turn : snapshot.parent };
  } } }) } as unknown as SessionTurnProjectionClient;
  await readRegistration(source, expected.sessionId, expected.turnId, { signal: caller.signal });
  assert.equal(timeout.mock.callCount(), 1);
  assert.equal(signals[0], signals[1]);
  const cancelled = new Error("registration cancelled"); caller.abort(cancelled);
  assert.equal(signals[0]?.reason, cancelled);
  await assert.rejects(readRegistration(source, expected.sessionId, expected.turnId, { signal: caller.signal }), error => error === cancelled);
  assert.equal(signals.length, 2, "already cancelled work never starts an HTTP read");

  const stalled = { session: () => ({ turns: { get: async (_turnId: string, options?: { signal?: AbortSignal }) => {
    const signal = options?.signal; assert(signal);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } } }) } as unknown as SessionTurnProjectionClient;
  const pending = readRegistration(stalled, expected.sessionId, expected.turnId);
  const timedOut = new DOMException("Registration deadline exceeded", "TimeoutError"); deadline.abort(timedOut);
  await assert.rejects(pending, error => error === timedOut);
});
