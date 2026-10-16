import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGenerationOperation } from "./dist/generation/index.js";

const model = {
  schema: "neta.generation.model.v1",
  model: "meshy",
  content: { input: [] },
  parameters: {
    operation: { type: "string", enum: ["text-to-3d", "image-to-3d"], default: "text-to-3d" },
    poll_interval: { type: "integer", optional: true, default: 5 },
  },
  operations: {
    "text-to-3d": {
      content: { input: [{ type: "text", required: true }] },
      parameters: {
        target_formats: { type: "array", optional: true, items: { type: "string", enum: ["glb", "obj"] } },
      },
    },
    "image-to-3d": {
      content: { input: [{ type: "image", required: true, min: 1, max: 1 }] },
    },
  },
};

test("resolveGenerationOperation keeps a model without operations unchanged", () => {
  const plain = { schema: "neta.generation.model.v1", model: "plain", content: { input: [] } };
  assert.equal(resolveGenerationOperation(plain, {}), plain);
});

test("resolveGenerationOperation merges the selected operation and drops the operations key", () => {
  const resolved = resolveGenerationOperation(model, { operation: "text-to-3d" });
  assert.equal("operations" in resolved, false);
  assert.deepEqual(resolved.content.input.map((spec) => spec.type), ["text"]);
  assert.deepEqual(Object.keys(resolved.parameters ?? {}), ["operation", "poll_interval", "target_formats"]);
});

test("resolveGenerationOperation falls back to the operation default", () => {
  const resolved = resolveGenerationOperation(model, {});
  assert.deepEqual(resolved.content.input.map((spec) => spec.type), ["text"]);
});

test("resolveGenerationOperation keeps the model unchanged until an operation is selected", () => {
  const withoutDefault = structuredClone(model);
  delete withoutDefault.parameters.operation.default;
  assert.equal(resolveGenerationOperation(withoutDefault, {}), withoutDefault);
  assert.equal(resolveGenerationOperation(model, { operation: "unknown" }), model);
});

test("resolveGenerationOperation does not mutate the declaration", () => {
  const snapshot = structuredClone(model);
  resolveGenerationOperation(model, { operation: "image-to-3d" });
  assert.deepEqual(model, snapshot);
});
