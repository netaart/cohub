import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerationValidationError, getBuiltinGenerationModel } from "@neta-art/generation";
import { createGenerationTaskRequestSchema, resolveGenerationRequestParameters } from "./schema.js";

const MODEL_URL = "https://example.com/model.glb";

const request = (content: unknown[], parameters: Record<string, unknown> = { operation: "retexture" }) => ({
  spaceId: "7017ac35-af78-4274-af06-69e84174427b",
  model: "meshy",
  content,
  parameters,
});

const meshy = () => {
  const declaration = getBuiltinGenerationModel("meshy");
  assert.ok(declaration, "the Generation SDK declares meshy");
  return declaration;
};

test("accepts 3d content blocks with a URL or inline source", () => {
  const parsed = createGenerationTaskRequestSchema.parse(request([
    { type: "3d", source: { type: "url", url: MODEL_URL }, meta: { task_id: "task_1" } },
    { type: "3d", source: { type: "base64", mediaType: "model/gltf-binary", data: "Z2xURg==" } },
    { type: "text", text: "weathered bronze" },
  ]));
  assert.deepEqual(parsed.content[0], {
    type: "3d",
    source: { type: "url", url: MODEL_URL },
    meta: { task_id: "task_1" },
  });
  assert.equal(parsed.content[1]?.type, "3d");
});

test("rejects unknown content block types and 3d blocks without a source", () => {
  assert.equal(createGenerationTaskRequestSchema.safeParse(request([{ type: "mesh", text: "x" }])).success, false);
  assert.equal(createGenerationTaskRequestSchema.safeParse(request([{ type: "3d" }])).success, false);
});

test("resolves a Meshy retexture of a 3d block against the meshy declaration", () => {
  const parsed = createGenerationTaskRequestSchema.parse(request(
    [
      { type: "3d", source: { type: "url", url: MODEL_URL } },
      { type: "text", text: "polished bronze" },
    ],
    { operation: "retexture", enable_pbr: true, target_formats: ["glb"] },
  ));
  assert.deepEqual(resolveGenerationRequestParameters(meshy(), parsed), {
    operation: "retexture",
    poll_interval: 5,
    max_wait: 3600,
    enable_pbr: true,
    target_formats: ["glb"],
  });
});

test("rejects a Meshy retexture without the model to texture", () => {
  const parsed = createGenerationTaskRequestSchema.parse(request([{ type: "text", text: "polished bronze" }]));
  assert.throws(() => resolveGenerationRequestParameters(meshy(), parsed), GenerationValidationError);
});
