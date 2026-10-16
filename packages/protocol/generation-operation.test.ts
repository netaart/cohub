import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generationModelInputType,
  generationOperations,
  resolveGenerationOperation,
  selectedGenerationOperation,
  type GenerationModelDeclaration,
} from "./src/generation/index.js";

const declaration = {
  schema: "neta.generation.model.v1",
  model: "meshy",
  category: "3d",
  content: { input: [] },
  parameters: {
    operation: { type: "string", enum: ["text-to-3d", "image-to-3d"] },
    poll_interval: { type: "integer", optional: true, default: 5 },
  },
  operations: {
    "text-to-3d": {
      title: "Text To 3D",
      content: { input: [{ type: "text", required: true }] },
      parameters: { target_formats: { type: "array", items: { type: "string", enum: ["glb", "obj"] } } },
    },
    "image-to-3d": {
      content: { input: [{ type: "image", required: true, max: 2 }] },
    },
  },
} as unknown as Omit<GenerationModelDeclaration, "adapter">;

const withDefault = {
  ...declaration,
  parameters: {
    ...declaration.parameters,
    operation: { type: "string" as const, enum: ["text-to-3d", "image-to-3d"], default: "image-to-3d" },
  },
};

test("resolveGenerationOperation merges the selected operation and drops the operations key", () => {
  const resolved = resolveGenerationOperation(declaration, { operation: "text-to-3d" });
  assert.equal("operations" in resolved, false);
  assert.deepEqual(resolved.content.input.map((spec) => spec.type), ["text"]);
  assert.deepEqual(Object.keys(resolved.parameters ?? {}), ["operation", "poll_interval", "target_formats"]);
});

test("an operation parameter default selects the operation", () => {
  assert.deepEqual(resolveGenerationOperation(withDefault, {}).content.input.map((spec) => spec.type), ["image"]);
  assert.equal(selectedGenerationOperation(withDefault, {})?.name, "image-to-3d");
});

test("a model without a selected operation stays unchanged, so the caller reports the missing parameter", () => {
  assert.equal(resolveGenerationOperation(declaration, {}), declaration);
  assert.equal(resolveGenerationOperation(declaration, { operation: "unknown" }), declaration);
});

test("models without operations resolve to themselves", () => {
  const plain = { schema: "neta.generation.model.v1", model: "plain", content: { input: [] } } as const;
  assert.equal(resolveGenerationOperation(plain, {}), plain);
  assert.deepEqual(generationOperations(plain), []);
  assert.equal(selectedGenerationOperation(plain, {}), null);
});

test("operations list in the order the operation parameter declares", () => {
  assert.deepEqual(generationOperations(declaration).map((operation) => operation.name), ["text-to-3d", "image-to-3d"]);
  assert.equal(selectedGenerationOperation(declaration, { operation: "image-to-3d" })?.name, "image-to-3d");
  assert.equal(selectedGenerationOperation(declaration, {}), null);
});

test("resolveGenerationOperation does not mutate the declaration", () => {
  const snapshot = structuredClone(declaration);
  resolveGenerationOperation(declaration, { operation: "image-to-3d" });
  assert.deepEqual(declaration, snapshot);
});

test("generation inputs recognize 3D models by filename extension", () => {
  assert.equal(generationModelInputType("models/Robot.GLB"), "model/gltf-binary");
  assert.equal(generationModelInputType("scene.gltf"), "model/gltf+json");
  assert.equal(generationModelInputType("part.obj"), "model/obj");
  assert.equal(generationModelInputType("part.stl"), "model/stl");
  assert.equal(generationModelInputType("pose.fbx"), "application/octet-stream");
  assert.equal(generationModelInputType("preview.png"), null);
  assert.equal(generationModelInputType("no-extension"), null);
});
