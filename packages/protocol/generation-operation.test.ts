import assert from "node:assert/strict";
import { test } from "node:test";
import { getBuiltinGenerationModel } from "@neta-art/generation";
import { generationOperations } from "./dist/generation/index.js";

test("Meshy operations preserve declared order and input/parameter specifications", () => {
  const model = getBuiltinGenerationModel("meshy");
  assert.ok(model);
  const snapshot = structuredClone(model);
  const operations = generationOperations(model);
  assert.deepEqual(operations.map(({ name }) => name), model.parameters?.operation?.type === "string" ? model.parameters.operation.enum : []);
  const animation = operations.find(({ name }) => name === "animation");
  assert.ok(animation);
  assert.deepEqual(animation.parameters, model.operations?.animation.parameters);
  assert.deepEqual(animation.content, model.operations?.animation.content);
  assert.deepEqual(model, snapshot);
});

test("operations follow declaration order without an enum and ignore missing entries", () => {
  const model = getBuiltinGenerationModel("meshy");
  assert.ok(model?.operations);
  assert.deepEqual(generationOperations({ operations: model.operations }).map(({ name }) => name), Object.keys(model.operations));
  const { animation: _animation, ...operations } = model.operations;
  assert.equal(generationOperations({ ...model, operations }).some(({ name }) => name === "animation"), false);
  assert.deepEqual(generationOperations({}), []);
});
