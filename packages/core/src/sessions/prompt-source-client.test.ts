import assert from "node:assert/strict";
import test from "node:test";
import type { SessionPromptDependencies, SubmitSessionPromptInput } from "./prompt.js";
import { submitSessionPrompt } from "./prompt.js";

const CLIENT_ID = "abc123def456abc789def012";

const createInput = (sourceClientId: string | null): SubmitSessionPromptInput => ({
  spaceId: "space-1",
  sessionId: "session-1",
  userId: "user-1",
  clientMessageId: "message-1",
  content: [{ type: "text", text: "Hello" }],
  source: "web",
  sourceClientId,
});

const captureTurnMeta = async (sourceClientId: string | null) => {
  const turnMetas: Record<string, unknown>[] = [];
  const deps: SessionPromptDependencies = {
    randomUUID: () => "message-id",
    expandPromptTemplate: async () => null,
    createSessionTurn: async (input) => {
      turnMetas.push(input.meta);
      return { id: "turn-id", spaceId: "space-1" };
    },
    enqueueSpacePrompt: async () => undefined,
    failSessionTurn: async () => undefined,
  };

  await submitSessionPrompt(deps, createInput(sourceClientId));
  return turnMetas[0];
};

test("prompt meta keeps source and source client id as sibling fields", async () => {
  const meta = await captureTurnMeta(` ${CLIENT_ID} `);
  assert.equal(meta?.source, "web");
  assert.equal(meta?.sourceClientId, CLIENT_ID);
});

test("prompt meta rejects an invalid source client id", async () => {
  const meta = await captureTurnMeta("invalid client id");
  assert.equal(meta?.source, "web");
  assert.equal(meta?.sourceClientId, undefined);
});

test("enqueue uses the created turn space instead of the request space", async () => {
  let enqueuedInput: Parameters<SessionPromptDependencies["enqueueSpacePrompt"]>[0] | undefined;
  let failedInput: Parameters<SessionPromptDependencies["failSessionTurn"]>[0] | undefined;
  const deps: SessionPromptDependencies = {
    randomUUID: () => "message-id",
    expandPromptTemplate: async () => null,
    createSessionTurn: async () => ({ id: "turn-id", spaceId: "canonical-space" }),
    enqueueSpacePrompt: async (input) => {
      enqueuedInput = input;
      throw new Error("queue unavailable");
    },
    failSessionTurn: async (input) => {
      failedInput = input;
    },
  };

  await assert.rejects(submitSessionPrompt(deps, createInput(null)), /queue unavailable/);
  assert.equal(enqueuedInput?.spaceId, "canonical-space");
  assert.deepEqual(failedInput, {
    sessionId: "session-1",
    turnId: "turn-id",
    errorMessage: "queue unavailable",
  });
});

test("local harness prompts still expand platform prompt templates", async () => {
  const turnMetas: Record<string, unknown>[] = [];
  const turnContents: { userContent: unknown[] }[] = [];
  const deps: SessionPromptDependencies = {
    randomUUID: () => "message-id",
    expandPromptTemplate: async () => ({
      renderedText: "expanded template body",
      template: { name: "plan", description: "Plan work", scope: "user" as const },
      args: ["feature-x"],
      rawInput: "/plan feature-x",
    }),
    createSessionTurn: async (input) => {
      turnMetas.push(input.meta);
      turnContents.push({ userContent: input.userContent });
      return { id: "turn-id", spaceId: "space-1" };
    },
    enqueueSpacePrompt: async () => undefined,
    failSessionTurn: async () => undefined,
    validateLocalHarness: async () => undefined,
  };

  await submitSessionPrompt(deps, {
    ...createInput(null),
    content: [{ type: "text", text: "/plan feature-x" }],
    harness: "pi",
  });

  assert.equal((turnMetas[0]?.promptTemplate as Record<string, unknown> | null | undefined)?.name, "plan");
  const text = (turnContents[0]?.userContent[0] as { type: string; text?: string } | undefined);
  assert.equal(text?.type, "text");
  assert.equal(text?.text, "expanded template body");
});
