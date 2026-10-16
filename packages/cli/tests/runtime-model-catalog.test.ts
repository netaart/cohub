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
  }, { id: "plain", provider: "fixture", reasoning: false }], { model: { provider: "fixture", id: "test" }, thinkingLevel: "medium" });
  const parsed = runtimeCapabilitiesSchema.parse({ harnesses: ["pi"], models });
  const items = toLocalModelCatalog(parsed.models);
  assert(items[0] && items[1]);
  assert.deepEqual(getSupportedThinkingLevels(items[0]), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(getSupportedThinkingLevels(items[1]), ["off"]);
  // Pi's current model is its default; its level is resolved for that model only.
  assert.deepEqual(parsed.models.map((model) => [model.isDefault, model.defaultThinkingLevel]), [[true, "medium"], [undefined, undefined]]);
  assert.equal(getModelDefaultThinkingLevel(items[0]), "medium");
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

test("Codex marks its configured model as the default, else the catalog default", () => {
  const entries = [{ id: "a", isDefault: true }, { id: "b" }];
  const defaults = (config: Record<string, unknown>) =>
    codexModelCatalog({ config }, entries).filter((model) => model.isDefault).map((model) => model.id);
  assert.deepEqual(defaults({}), ["a"]);
  assert.deepEqual(defaults({ model: "b" }), ["b"]);
  assert.deepEqual(defaults({ model: "unlisted" }), ["unlisted"]);
});

test("older Runtime capabilities remain valid and offer no invented reasoning choices", () => {
  const models = [{ harness: "pi", provider: "fixture", id: "test", name: "Test" }];
  const parsed = runtimeCapabilitiesSchema.parse({ harnesses: ["pi"], models });
  assert.deepEqual(parsed.models, models);
  const [item] = toLocalModelCatalog(parsed.models);
  assert(item);
  assert.deepEqual(getSupportedThinkingLevels(item), ["off"]);
});

test("custom Codex providers retain the native picker catalog and reasoning choices", () => {
  const entries = [
    { id: "first", displayName: "First", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort })) },
    { id: "configured", displayName: "Configured", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort })) },
    { id: "hidden", hidden: true },
  ];
  for (const catalog of [undefined, null, "/local/catalog.json"]) {
    const models = codexModelCatalog({ config: { model_provider: "crs", model: "configured", model_reasoning_effort: "xhigh", model_catalog_json: catalog } }, entries);
    const parsed = runtimeCapabilitiesSchema.parse({ harnesses: ["codex"], models });
    assert.deepEqual(parsed.models.map(({ id, provider, name, isDefault }) => ({ id, provider, name, isDefault })), [
      { id: "first", provider: "crs", name: "First", isDefault: undefined },
      { id: "configured", provider: "crs", name: "Configured", isDefault: true },
    ]);
    const [first, configured] = toLocalModelCatalog(parsed.models);
    assert(first && configured);
    assert.deepEqual(getSupportedThinkingLevels(first), ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(getSupportedThinkingLevels(configured), ["medium", "high", "xhigh", "max"]);
    assert.equal(getModelDefaultThinkingLevel(configured), "xhigh");
  }
});

test("custom Codex providers retain an unlisted configured model without guessing capabilities", () => {
  const config = { model_provider: "custom", model: "unlisted" };
  const fallback = { harness: "codex", provider: "custom", id: "unlisted", name: "unlisted", isDefault: true };
  assert.deepEqual(codexModelCatalog({ config }, []), [fallback]);
  assert.deepEqual(codexModelCatalog({ config }, [{ id: "listed", isDefault: true }]), [
    fallback,
    { harness: "codex", provider: "custom", id: "listed", name: "listed" },
  ]);
});

const fastTier = { id: "priority", name: "Fast", description: "Higher speed" };

test("Codex advertises Fast only from its service tier catalog and honors supported defaults", () => {
  for (const [config, catalogDefault, expected] of [
    [{}, null, null], [{}, "priority", "priority"], [{ service_tier: "priority" }, null, "priority"],
    [{ service_tier: null }, "priority", "priority"], [{ service_tier: "flex" }, "priority", null],
  ] as const) {
    const [model] = codexModelCatalog({ config }, [{ id: "test", serviceTiers: [fastTier, { id: "flex", name: "Flex", description: "" }], defaultServiceTier: catalogDefault }]);
    assert.deepEqual(model?.serviceTiers, [fastTier]);
    assert.equal(model?.defaultServiceTier, expected);
  }
  const [unsupported] = codexModelCatalog({ config: { service_tier: "priority" } }, [{ id: "test", serviceTiers: [], defaultServiceTier: null }]);
  assert.deepEqual(unsupported?.serviceTiers, []);
  assert.equal(unsupported?.defaultServiceTier, null);
});

test("Codex uses advertised Fast capabilities for every provider without inventing support", () => {
  for (const entries of [[{ id: "test" }], [{ id: "test", additionalSpeedTiers: ["fast"] }]]) {
    const [model] = codexModelCatalog({ config: { service_tier: "priority" } }, entries);
    assert.equal(model?.serviceTiers, undefined);
    assert.equal(model?.defaultServiceTier, undefined);
  }
  const entries = [{ id: "test", serviceTiers: [fastTier], defaultServiceTier: "priority" }];
  const [custom] = codexModelCatalog({ config: { model: "test", model_provider: "custom" } }, entries);
  assert.deepEqual(custom?.serviceTiers, [fastTier]);
  const [unadvertised] = codexModelCatalog({ config: { model: "test", model_provider: "custom" } }, [{ id: "test" }]);
  assert.equal(unadvertised?.serviceTiers, undefined);
  const [explicit] = codexModelCatalog({ config: { model: "test", model_provider: "custom", model_catalog_json: "/catalog.json" } }, entries);
  assert.deepEqual(explicit?.serviceTiers, [fastTier]);
});

test("Codex reports malformed service tier metadata instead of hiding it", () => {
  for (const metadata of [
    { serviceTiers: null }, { serviceTiers: {} }, { serviceTiers: [null] },
    { serviceTiers: [{ id: "priority", name: 42 }] },
    { serviceTiers: [{ id: "priority", name: "Fast", description: false }] },
    { serviceTiers: [{ id: "", name: "Fast" }] },
    { serviceTiers: [fastTier, fastTier] },
    { serviceTiers: [fastTier], defaultServiceTier: false },
  ]) assert.throws(() => codexModelCatalog({ config: {} }, [{ id: "test", ...metadata }]), /Invalid Codex service tier/);
  assert.throws(() => codexModelCatalog({ config: { service_tier: 42 } }, [{ id: "test", serviceTiers: [fastTier] }]), /Invalid Codex service tier/);
});
