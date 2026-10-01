import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSessionTurnOrigin, readSessionTurnOrigin, turnEventRequestSource } from "./dist/model/session.js";
import { normalizeRequestSource, parseRequestSourceFromHeaders, readRequestSourceFromEnv, requestSourceToHeaders } from "./dist/provenance.js";

const source = {
  spaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
  toolCallId: "call_review_1",
};

test("origin keeps caller identity, accepts opaque tool ids and ignores unrelated metadata", () => {
  const origin = { ...source, kind: "prompt", depth: 1 };
  assert.deepEqual(normalizeSessionTurnOrigin({ ...origin, auth: "not provenance" }), origin);
  assert.deepEqual(readSessionTurnOrigin({ origin, source: "cli" }), origin);
  for (const invalid of [null, [], "local_import", {}, { ...origin, turnId: "invalid" }, { ...origin, kind: "unknown" }]) {
    assert.equal(normalizeSessionTurnOrigin(invalid), null);
  }
  for (const depth of [-1, 0, 1.5, NaN, Infinity]) {
    assert.equal(normalizeSessionTurnOrigin({ ...origin, depth })?.depth, undefined);
  }
});

test("legacy task origins use the owning space and do not invent a depth", () => {
  const meta = { context: { kind: "background_bash_task", origin: { sessionId: source.sessionId, turnId: source.turnId, toolCallId: source.toolCallId } } };
  assert.deepEqual(readSessionTurnOrigin(meta, source.spaceId), { ...source, kind: "background_task" });
  assert.equal(readSessionTurnOrigin(meta), null);
  assert.equal(readSessionTurnOrigin({ context: { ...meta.context, kind: "scheduled_task" } }, source.spaceId), null);
});

test("CLI environment, HTTP headers and origin retain the same opaque tool call id", () => {
  for (const toolCallId of [source.toolCallId, "toolu_01Review", source.turnId]) {
    const fromEnv = readRequestSourceFromEnv({ COHUB_SPACE_ID: source.spaceId, COHUB_SESSION_ID: source.sessionId, COHUB_TURN_ID: source.turnId, COHUB_TOOL_CALL_ID: toolCallId });
    const headers = requestSourceToHeaders(fromEnv);
    const parsed = parseRequestSourceFromHeaders((name) => headers[name]);
    assert.deepEqual(parsed, { ...source, toolCallId });
    assert.equal(normalizeSessionTurnOrigin({ ...parsed, kind: "prompt" })?.toolCallId, toolCallId);
  }
  assert.equal(normalizeRequestSource({ toolCallId: "x".repeat(256) }), null);
  assert.equal(normalizeRequestSource({ toolCallId: "call_test\r\n" })?.toolCallId, "call_test");
});

test("only turn-finalized hooks name a causal Turn", () => {
  const event = { type: "session.turn.finalized", spaceId: source.spaceId, sessionId: source.sessionId, payload: { turn: { id: source.turnId } } };
  assert.deepEqual(turnEventRequestSource(event), { spaceId: source.spaceId, sessionId: source.sessionId, turnId: source.turnId });
  assert.equal(turnEventRequestSource({ ...event, type: "space.fs.changed" }), null);
  assert.equal(turnEventRequestSource({ ...event, payload: {} }), null);
});
