import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTurnOrigin } from "./turn-origin.js";
import { submitSessionPrompt, type SessionPromptDependencies, type SubmitSessionPromptInput } from "./prompt.js";
import { turnTriggerReference } from "../references/turn-trigger.js";
import type { SessionTurnOrigin } from "@cohub/protocol/model";

const SPACE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const TURN = "33333333-3333-4333-8333-333333333333";
const OTHER_SPACE = "44444444-4444-4444-8444-444444444444";
const CHILD_SESSION = "55555555-5555-4555-8555-555555555555";
const CHILD_TURN = "66666666-6666-4666-8666-666666666666";
const source = { spaceId: SPACE, sessionId: SESSION, turnId: TURN, toolCallId: "call_review" };
const origin: SessionTurnOrigin = { ...source, kind: "prompt", depth: 1 };
const parent = { sessionId: SESSION, spaceId: SPACE, meta: null };

test("resolve uses one caller lookup, never a target session's latest turn", async () => {
  let lookups = 0;
  const find = async (id: string) => { lookups++; assert.equal(id, TURN); return parent; };
  assert.equal(await resolveTurnOrigin(find, { via: "web" }, "prompt"), null);
  assert.equal(lookups, 0);
  assert.deepEqual(await resolveTurnOrigin(find, source, "prompt"), origin);
  assert.equal(lookups, 1);
  assert.equal(await resolveTurnOrigin(async () => null, source, "prompt"), null);
  assert.equal(await resolveTurnOrigin(find, { ...source, sessionId: CHILD_SESSION }, "prompt"), null);
  assert.equal(await resolveTurnOrigin(find, { ...source, spaceId: OTHER_SPACE }, "prompt"), null);
});

test("HTTP origins require source Session visibility before disclosing ancestry", async () => {
  for (const source of [{ turnId: TURN }, { spaceId: SPACE, sessionId: SESSION, turnId: TURN }]) {
    const checks: unknown[] = [];
    const resolved = await resolveTurnOrigin(async () => parent, source, "prompt", async (scope) => {
      checks.push(scope);
      return false;
    });
    assert.equal(resolved, null);
    assert.deepEqual(checks, [{ spaceId: SPACE, sessionId: SESSION }]);
    const allowed = await resolveTurnOrigin(async () => parent, source, "prompt", async () => true);
    assert.equal(allowed?.sessionId, SESSION);
  }
  await assert.rejects(resolveTurnOrigin(async () => parent, source, "prompt", async () => {
    throw new Error("Permission lookup failed");
  }), /Permission lookup failed/);
  const unexpectedCheck = async () => { throw new Error("Unexpected permission check"); };
  assert.equal(await resolveTurnOrigin(async () => parent, null, "prompt", unexpectedCheck), null);
  assert.equal(await resolveTurnOrigin(async () => null, source, "prompt", unexpectedCheck), null);
});

test("depth follows the actual caller, with unknown legacy ancestry left unknown", async () => {
  assert.equal((await resolveTurnOrigin(async () => ({ ...parent, meta: { origin } }), source, "prompt"))?.depth, 2);
  const { depth: _depth, ...legacy } = origin;
  assert.equal((await resolveTurnOrigin(async () => ({ ...parent, meta: { origin: legacy } }), source, "prompt"))?.depth, undefined);
});

function fixture() {
  const created: Array<{ id: string; sessionId: string; spaceId: string; meta: Record<string, unknown> }> = [];
  const deps: SessionPromptDependencies = {
    randomUUID: () => "message-id",
    expandPromptTemplate: async () => null,
    resolveOrigin: (source, kind) => resolveTurnOrigin(async () => parent, source, kind),
    createSessionTurn: async (input) => {
      const id = created.length === 0 ? CHILD_TURN : `${CHILD_TURN.slice(0, -2)}${created.length.toString(16).padStart(2, "0")}`;
      created.push({ id, sessionId: input.sessionId, spaceId: SPACE, meta: input.meta });
      return { id, spaceId: SPACE };
    },
    enqueueSpacePrompt: async ({ meta }) => assert.deepEqual(meta.origin, created.at(-1)?.meta.origin),
    failSessionTurn: async () => undefined,
  };
  const input: SubmitSessionPromptInput = {
    spaceId: SPACE, sessionId: CHILD_SESSION, userId: "user", clientMessageId: "request",
    content: [{ type: "text", text: "/review" }], source: "cli", requestSource: source,
  };
  return { deps, input, created };
}

for (const [name, spaceId, sessionId] of [
  ["same-space child", SPACE, CHILD_SESSION],
  ["cross-space child", OTHER_SPACE, CHILD_SESSION],
  ["self follow-up", SPACE, SESSION],
] as const) {
  test(`${name} keeps the same caller and emits a distinct causal edge`, async () => {
    const { deps, input, created } = fixture();
    await submitSessionPrompt(deps, { ...input, spaceId, sessionId });
    const child = created[0];
    assert.ok(child);
    assert.deepEqual(child.meta.origin, origin);
    assert.equal(child.meta.source, "cli");
    const edge = turnTriggerReference({ ...child, spaceId });
    assert.deepEqual(edge, {
      kind: "turn_trigger", sourceType: "turn", sourceId: TURN,
      sourceSpaceId: SPACE, sourceSessionId: SESSION, targetType: "turn", targetId: CHILD_TURN,
      count: 1, meta: { kind: "prompt", targetSpaceId: spaceId, targetSessionId: sessionId, toolCallId: "call_review" },
    });
    assert.deepEqual(turnTriggerReference({ ...child, spaceId }), edge);
    assert.equal(edge?.countMode, undefined);
  });
}

test("review loop keeps all five sends attached to the sending parent turn", async () => {
  const { deps, input, created } = fixture();
  for (let round = 0; round < 5; round++) await submitSessionPrompt(deps, input);
  assert.equal(created.length, 5);
  assert.equal(new Set(created.map((turn) => turnTriggerReference(turn)?.targetId)).size, 5);
  for (const child of created) assert.deepEqual(child.meta.origin, origin);
});

test("a later parent Turn sending to the same review Session becomes the new caller", async () => {
  const { deps, input, created } = fixture();
  await submitSessionPrompt(deps, input);
  await submitSessionPrompt(deps, { ...input, requestSource: { ...source, turnId: CHILD_TURN } });
  assert.deepEqual(created[1]?.meta.origin, { ...origin, turnId: CHILD_TURN });
});

test("turn-finalized prompt hooks preserve both caller and event context", async () => {
  const { deps, input, created } = fixture();
  const context = { kind: "space_hook" as const, taskRunId: "hook-run", hookPath: "hooks/review", eventId: "event-1", eventType: "session.turn.finalized" };
  await submitSessionPrompt(deps, { ...input, context });
  assert.deepEqual(created[0]?.meta.origin, { ...origin, kind: "hook" });
  assert.deepEqual(created[0]?.meta.context, context);
});

test("cron executions retain both the original creator and their own task/cron context", async () => {
  const { deps, input, created } = fixture();
  deps.resolveOrigin = async () => { throw new Error("Must not re-resolve a scheduled snapshot"); };
  const scheduled = { ...origin, kind: "scheduled_prompt" as const };
  for (const taskRunId of ["run-1", "run-2"]) {
    const context = { kind: "scheduled_task" as const, taskRunId, cronJobId: "cron-1" };
    await submitSessionPrompt(deps, { ...input, origin: scheduled, context });
    assert.deepEqual(created.at(-1)?.meta.origin, scheduled);
    assert.deepEqual(created.at(-1)?.meta.context, context);
  }
});

test("a rejected HTTP origin is not resolved again by prompt submission", async () => {
  const { deps, input, created } = fixture();
  deps.resolveOrigin = async () => { throw new Error("Rejected source must not be re-resolved"); };
  await submitSessionPrompt(deps, { ...input, origin: null });
  const child = created[0];
  assert.ok(child);
  assert.equal(child.meta.origin, undefined);
  assert.deepEqual(child.meta.requestSource, source);
  assert.equal(turnTriggerReference(child), null);
});

test("background completion normalizes existing origin without changing its task context", async () => {
  const { deps, input, created } = fixture();
  const context = { kind: "background_bash_task" as const, taskRunId: "task-1", origin: { kind: "bash_tool_call" as const, sessionId: SESSION, turnId: TURN, toolCallId: "call_bash" } };
  await submitSessionPrompt(deps, { ...input, requestSource: undefined, context });
  assert.deepEqual(created[0]?.meta.origin, { ...origin, kind: "background_task", toolCallId: "call_bash" });
  assert.deepEqual(created[0]?.meta.context, context);
});

test("provenance survives queue failure; user prompts and missing parents invent no links", async () => {
  const { deps, input, created } = fixture();
  deps.enqueueSpacePrompt = async () => { throw new Error("Queue unavailable"); };
  await assert.rejects(submitSessionPrompt(deps, input), /Queue unavailable/);
  assert.deepEqual(created[0]?.meta.origin, origin);
  deps.enqueueSpacePrompt = async () => undefined;
  await submitSessionPrompt(deps, { ...input, requestSource: undefined });
  const userTurn = created[1];
  assert.ok(userTurn);
  assert.equal(turnTriggerReference(userTurn), null);
  deps.resolveOrigin = async () => null;
  await submitSessionPrompt(deps, input);
  assert.equal(created[2]?.meta.origin, undefined);
  assert.deepEqual(created[2]?.meta.requestSource, source);
});
