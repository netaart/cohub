import assert from "node:assert/strict";
import { test } from "node:test";
import { createGenerationTaskRequestSchema } from "./schema.js";

const request = (content: unknown[]) => ({
  spaceId: "7017ac35-af78-4274-af06-69e84174427b",
  model: "meshy",
  content,
  parameters: { operation: "retexture" },
});

test("accepts 3d content blocks with a URL or inline source", () => {
  const parsed = createGenerationTaskRequestSchema.parse(request([
    { type: "3d", source: { type: "url", url: "https://example.com/model.glb" }, meta: { task_id: "task_1" } },
    { type: "3d", source: { type: "base64", mediaType: "model/gltf-binary", data: "Z2xURg==" } },
    { type: "text", text: "weathered bronze" },
  ]));
  assert.deepEqual(parsed.content[0], {
    type: "3d",
    source: { type: "url", url: "https://example.com/model.glb" },
    meta: { task_id: "task_1" },
  });
  assert.equal(parsed.content[1]?.type, "3d");
});

test("rejects unknown content block types and 3d blocks without a source", () => {
  assert.equal(createGenerationTaskRequestSchema.safeParse(request([{ type: "mesh", text: "x" }])).success, false);
  assert.equal(createGenerationTaskRequestSchema.safeParse(request([{ type: "3d" }])).success, false);
});
