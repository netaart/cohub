import assert from "node:assert/strict";
import { test } from "node:test";
import { codexModelCatalog, piModelCatalog } from "../src/runtime/model-catalog.js";
import { runtimeCapabilitiesSchema } from "../../protocol/src/runtime/index.js";
import { getModelDefaultThinkingLevel, getSupportedThinkingLevels, toLocalModelCatalog } from "../../../apps/web/src/lib/model-catalog.ts";

test("Codex reasoning choices survive discovery and the server capability schema", () => {
  const models = codexModelCatalog({ config: { model_provider: "openai" } }, [{
    id: "test", displayName: "Test", defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort })),
  }]);
  const [item] = toLocalModelCatalog(runtimeCapabilitiesSchema.parse({ harnesses: ["codex"], models }).models);
  assert(item);
  assert.deepEqual(getSupportedThinkingLevels(item), ["off", "low", "medium", "high", "xhigh"]);
  assert.equal(getModelDefaultThinkingLevel(item), "medium");
});

test("Pi reasoning metadata reaches the picker without provider configuration", () => {
  const models = piModelCatalog([{
    id: "test", provider: "fixture", name: "Test", reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max", invalid: "ignored" },
    baseUrl: "https://private.example", headers: { Authorization: "secret" },
  }, { id: "plain", provider: "fixture", reasoning: false }]);
  const parsed = runtimeCapabilitiesSchema.parse({ harnesses: ["pi"], models });
  const items = toLocalModelCatalog(parsed.models);
  assert(items[0] && items[1]);
  assert.deepEqual(getSupportedThinkingLevels(items[0]), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(getSupportedThinkingLevels(items[1]), ["off"]);
  assert(!JSON.stringify(models).includes("private"));
  assert(!JSON.stringify(models).includes("secret"));
  assert(!JSON.stringify(models).includes("invalid"));
});

test("Codex honors a supported configured effort and filters unknown native efforts", () => {
  for (const [configured, expected] of [["low", "low"], ["none", "off"], ["unknown", "medium"], ["xhigh", "medium"]]) {
    const [model] = codexModelCatalog({ config: { model_reasoning_effort: configured } }, [{
      id: "test", defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["none", "low", "medium", "high", "future"].map((reasoningEffort) => ({ reasoningEffort })),
    }]);
    assert(model);
    assert.equal(model.defaultThinkingLevel, expected);
    const [item] = toLocalModelCatalog([model]);
    assert(item);
    assert.deepEqual(getSupportedThinkingLevels(item), ["off", "low", "medium", "high"]);
  }
});

test("older Runtime capabilities remain valid and offer no invented reasoning choices", () => {
  const models = [{ harness: "pi", provider: "fixture", id: "test", name: "Test" }];
  const parsed = runtimeCapabilitiesSchema.parse({ harnesses: ["pi"], models });
  assert.deepEqual(parsed.models, models);
  const [item] = toLocalModelCatalog(parsed.models);
  assert(item);
  assert.deepEqual(getSupportedThinkingLevels(item), ["off"]);
});

test("custom Codex providers do not inherit unsupported built-in reasoning choices", () => {
  const models = codexModelCatalog({ config: { model_provider: "custom", model: "test" } }, [{
    id: "test", supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  }]);
  assert.deepEqual(models, [{ harness: "codex", provider: "custom", id: "test", name: "test" }]);
});
