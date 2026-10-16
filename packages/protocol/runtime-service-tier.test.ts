import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeCapabilitiesSchema, runtimeCommandSchema } from "./src/runtime/index.js";
import { wsClientEventSchema } from "./src/realtime/schema.js";

const turnId = crypto.randomUUID(), userMessageId = crypto.randomUUID();
const base = { spaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), turnId, userMessageId, harness: "codex", messages: [{ turnId, userMessageId, userId: null, content: [{ type: "text", text: "Hello" }] }], context: { revision: "r", throughTurnId: null, messages: [] }, accessMode: "full_access" };
test("Runtime and websocket preserve priority, explicit off and omitted tiers", () => {
  for (const patch of [{}, { serviceTier: null }, { serviceTier: "priority" }]) {
    const parsed = runtimeCommandSchema.parse({ type: "turn.start", requestId: crypto.randomUUID(), input: { ...base, ...patch } });
    assert.equal(parsed.type, "turn.start");
    if (parsed.type !== "turn.start") throw new Error("wrong command");
    assert.deepEqual(Object.fromEntries(Object.entries(parsed.input).filter(([key]) => key === "serviceTier")), patch);
    const ws = wsClientEventSchema.parse({ type: "session.message.create", payload: { spaceId: base.spaceId, sessionId: base.sessionId, harness: "codex", content: [{ type: "text", text: "Hello" }], ...patch } });
    assert.equal(ws.type, "session.message.create");
    if (ws.type !== "session.message.create") throw new Error("wrong event");
    assert.deepEqual(Object.fromEntries(Object.entries(ws.payload).filter(([key]) => key === "serviceTier")), patch);
  }
  for (const patch of [{ serviceTier: "fast" }, { serviceTier: false }, { harness: "pi", serviceTier: null }, { harness: "pi", serviceTier: "priority" }]) {
    assert.equal(runtimeCommandSchema.safeParse({ type: "turn.start", requestId: crypto.randomUUID(), input: { ...base, ...patch } }).success, false);
    assert.equal(wsClientEventSchema.safeParse({ type: "session.message.create", payload: { spaceId: base.spaceId, sessionId: base.sessionId, harness: "codex", content: [{ type: "text", text: "Hello" }], ...patch } }).success, false);
  }
});
test("Model capabilities retain available tiers and configured default", () => {
  const model = { harness: "codex", provider: "codex", id: "model", name: "Model", serviceTiers: [{ id: "priority", name: "Fast", description: "Higher cost" }], defaultServiceTier: null };
  assert.deepEqual(runtimeCapabilitiesSchema.parse({ harnesses: ["codex"], models: [model] }).models[0], model);
});

test("service tier validation fails closed for unsupported models and ambiguous defaults", async () => {
  const { validateRuntimeServiceTier } = await import("./src/runtime/index.js");
  const model = { harness: "codex" as const, provider: "codex", id: "supported", name: "Supported", isDefault: true, serviceTiers: [{ id: "priority" as const, name: "Fast" }] };
  const capabilities = { harnesses: ["codex" as const], models: [model, { ...model, id: "unsupported", isDefault: false, serviceTiers: [] }] };
  validateRuntimeServiceTier({ harness: "codex", serviceTier: "priority" }, capabilities);
  validateRuntimeServiceTier({ harness: "codex", serviceTier: null, model: "unsupported" }, capabilities);
  assert.throws(() => validateRuntimeServiceTier({ harness: "codex", serviceTier: "priority", model: "unsupported" }, capabilities), /unavailable/);
  assert.throws(() => validateRuntimeServiceTier({ harness: "pi", serviceTier: null }, capabilities), /Codex/);
  assert.throws(() => validateRuntimeServiceTier({ harness: "codex", serviceTier: "priority" }, { ...capabilities, models: [{ ...model, isDefault: false }] }), /unavailable/);
  assert.throws(() => validateRuntimeServiceTier({ harness: "codex", serviceTier: "priority" }, { ...capabilities, models: [model, { ...model, provider: "other" }] }), /unavailable/);
});

test("explicit off rejects legacy runtimes that cannot clear an inherited tier", async () => {
  const { validateRuntimeServiceTier } = await import("./src/runtime/index.js");
  const legacy = { harness: "codex" as const, provider: "codex", id: "model", name: "Model", isDefault: true };
  assert.throws(() => validateRuntimeServiceTier({ harness: "codex", serviceTier: null }, { harnesses: ["codex"], models: [legacy] }), /unavailable/);
  assert.throws(() => validateRuntimeServiceTier({ harness: "codex", serviceTier: null }, { harnesses: ["codex"], models: [{ ...legacy, isDefault: false, serviceTiers: [] }] }), /unavailable/);
  validateRuntimeServiceTier({ harness: "codex", serviceTier: null }, { harnesses: ["codex"], models: [{ ...legacy, serviceTiers: [] }] });
});
