import assert from "node:assert/strict";
import test from "node:test";
import type { SessionPromptDependencies, SubmitSessionPromptInput } from "./prompt.js";
import { ModelUnavailableError, submitSessionPrompt } from "./prompt.js";

const input: SubmitSessionPromptInput = {
  spaceId: "space-1",
  sessionId: "session-1",
  userId: " user-1 ",
  clientMessageId: "message-1",
  content: [{ type: "text", text: "Hello" }],
  source: "web",
  model: " model-1 ",
  provider: null,
};

function createDeps(validatePromptModel: SessionPromptDependencies["validatePromptModel"]): SessionPromptDependencies {
  return {
    randomUUID: () => "message-id",
    expandPromptTemplate: async () => null,
    createSessionTurn: async () => ({ id: "turn-id", spaceId: "space-1" }),
    enqueueSpacePrompt: async () => undefined,
    failSessionTurn: async () => undefined,
    validatePromptModel,
  };
}

test("matching prevalidated model skips duplicate model validation", async () => {
  let validationCalls = 0;
  const result = await submitSessionPrompt(
    createDeps(async () => {
      validationCalls += 1;
      return false;
    }),
    input,
    {},
    { prevalidatedModel: { provider: "cohub", model: "model-1" } },
  );

  assert.deepEqual(result, { turnId: "turn-id", userMessageId: "message-id" });
  assert.equal(validationCalls, 0);
});

test("mismatched prevalidated model still validates the requested model", async () => {
  let validatedInput: { userId: string; provider: string; model: string } | undefined;

  await assert.rejects(
    submitSessionPrompt(
      createDeps(async (modelInput) => {
        validatedInput = modelInput;
        return false;
      }),
      input,
      {},
      { prevalidatedModel: { provider: "cohub", model: "other-model" } },
    ),
    ModelUnavailableError,
  );

  assert.deepEqual(validatedInput, { userId: "user-1", provider: "cohub", model: "model-1" });
});

test("Codex service tiers preserve explicit off and reject invalid requests before mutations", async () => {
  const created: Array<Record<string, unknown>> = [];
  const deps = { ...createDeps(undefined), validateLocalHarness: async () => undefined,
    createSessionTurn: async (turn: Parameters<SessionPromptDependencies["createSessionTurn"]>[0]) => { created.push(turn.meta); return { id: "turn-id", spaceId: "space-1" }; },
  };
  for (const serviceTier of ["priority", null] as const) {
    await submitSessionPrompt(deps, { ...input, harness: "codex", serviceTier });
    assert.equal(created.at(-1)?.requestedServiceTier, serviceTier);
  }
  await submitSessionPrompt(deps, { ...input, harness: "codex" });
  assert.equal(Object.hasOwn(created.at(-1)!, "requestedServiceTier"), false);
  created.length = 0;
  for (const harness of ["pi", "cohub", undefined] as const) {
    await assert.rejects(submitSessionPrompt(deps, { ...input, harness, serviceTier: null }), /Codex/);
  }
  await assert.rejects(submitSessionPrompt(deps, { ...input, harness: "codex", serviceTier: "invalid" as "priority" }), /serviceTier/);
  assert.equal(created.length, 0);
});
