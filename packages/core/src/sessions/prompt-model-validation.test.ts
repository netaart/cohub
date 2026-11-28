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

function createDeps(resolvePromptModelCredential: SessionPromptDependencies["resolvePromptModelCredential"]): SessionPromptDependencies {
  return {
    randomUUID: () => "message-id",
    expandPromptTemplate: async () => null,
    createSessionTurn: async () => ({ id: "turn-id", spaceId: "space-1" }),
    enqueueSpacePrompt: async () => undefined,
    failSessionTurn: async () => undefined,
    resolvePromptModelCredential,
  };
}

test("matching prevalidated model skips duplicate model validation", async () => {
  let validationCalls = 0;
  const result = await submitSessionPrompt(
    createDeps(async () => {
      validationCalls += 1;
      return null;
    }),
    input,
    {},
    { prevalidatedModel: { provider: "cohub", model: "model-1", credential: "platform" } },
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
        return null;
      }),
      input,
      {},
      { prevalidatedModel: { provider: "cohub", model: "other-model", credential: "platform" } },
    ),
    ModelUnavailableError,
  );

  assert.deepEqual(validatedInput, { userId: "user-1", provider: "cohub", model: "model-1" });
});
