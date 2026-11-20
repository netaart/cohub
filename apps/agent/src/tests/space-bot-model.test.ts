import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CohubModelRegistry } from "../runtime/model-registry.js";
import { resolveSpaceBotPromptModel } from "../runtime/space-bot-model.js";

const root = await mkdtemp(join(tmpdir(), "space-bot-model-"));
process.env.WORKSPACE_ROOT = root;

const registry = {
  find: (provider: string, id: string) => (provider === "cohub" && id === "claude-opus-5-5" ? {} : undefined),
} as unknown as CohubModelRegistry;

async function writeBotJson(spaceId: string, content: unknown) {
  const dir = join(root, spaceId, "workspace", ".agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "bot.json"), typeof content === "string" ? content : JSON.stringify(content));
}

const bare = { requestedModel: undefined, requestedThinkingLevel: undefined, requestedContextWindow: undefined };

test("a bare prompt runs on the Space Bot's model, thinking level and window", async () => {
  await writeBotJson("bot-space", { model: { provider: "cohub", id: "claude-opus-5-5", thinkingLevel: "high" }, contextWindow: 400000 });
  assert.deepEqual(await resolveSpaceBotPromptModel("bot-space", bare, registry), {
    requestedModel: { provider: "cohub", id: "claude-opus-5-5" },
    requestedThinkingLevel: "high",
    requestedContextWindow: 400000,
  });
});

test("an explicit model wins over bot.json, and missing bot.json keeps the deployment default", async () => {
  await writeBotJson("explicit-space", { model: { provider: "cohub", id: "claude-opus-5-5", thinkingLevel: "high" }, contextWindow: 400000 });
  const explicit = { requestedModel: { provider: "cohub", id: "other" }, requestedThinkingLevel: "low", requestedContextWindow: 90000 };
  assert.deepEqual(await resolveSpaceBotPromptModel("explicit-space", explicit, registry), explicit);
  assert.deepEqual(await resolveSpaceBotPromptModel("no-bot-space", bare, registry), bare);
});

test("an unavailable or malformed bot.json falls back to the deployment default without failing", async () => {
  await writeBotJson("unknown-model-space", { model: { provider: "cohub", id: "gone" } });
  assert.deepEqual(await resolveSpaceBotPromptModel("unknown-model-space", bare, registry), bare);
  await writeBotJson("broken-space", "{ not json");
  assert.deepEqual(await resolveSpaceBotPromptModel("broken-space", bare, registry), bare);
});

test("a bot.json without a window pins 200k like tell, and an explicit thinking level beats bot.json", async () => {
  await writeBotJson("window-space", { model: { provider: "cohub", id: "claude-opus-5-5", thinkingLevel: "high" } });
  assert.deepEqual(await resolveSpaceBotPromptModel("window-space", bare, registry), {
    requestedModel: { provider: "cohub", id: "claude-opus-5-5" },
    requestedThinkingLevel: "high",
    requestedContextWindow: 200000,
  });
  const explicitLevel = { ...bare, requestedThinkingLevel: "low" };
  assert.deepEqual(await resolveSpaceBotPromptModel("window-space", explicitLevel, registry), {
    requestedModel: { provider: "cohub", id: "claude-opus-5-5" },
    requestedThinkingLevel: "low",
    requestedContextWindow: 200000,
  });
});
