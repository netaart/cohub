import assert from "node:assert/strict";
import { test } from "node:test";
import { isModelMime, isTextMime, mimeTypeForPath, modelFormatForPath } from "./src/fs/index.js";

test("recognizes model MIME without accepting prototype properties as filenames", () => {
  assert.equal(mimeTypeForPath("assets/Robot.GLB"), "model/gltf-binary");
  assert.equal(isModelMime(mimeTypeForPath("part.obj")), true);
  assert.equal(isTextMime(mimeTypeForPath("part.obj")), false);
  for (const name of ["constructor", "__proto__", "hasOwnProperty", "toString"]) {
    assert.equal(mimeTypeForPath(name), null);
  }
});

test("detects previewable model formats by name, then MIME type", () => {
  assert.equal(modelFormatForPath("assets/Robot.GLB"), "glb");
  assert.equal(modelFormatForPath("scan", "model/stl; charset=binary"), "stl");
  assert.equal(modelFormatForPath("part.obj"), null);
  assert.equal(modelFormatForPath("part.3mf", "model/3mf"), null);
  assert.equal(modelFormatForPath("constructor"), null);
});
