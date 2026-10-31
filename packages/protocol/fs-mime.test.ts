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
  assert.equal(modelFormatForPath("part.3mf", "model/3mf"), null);
  assert.equal(modelFormatForPath("constructor"), null);
});

test("treats .abc scores as text on every read path", () => {
  for (const path of ["scores/song.abc", "SONG.ABC"]) {
    assert.equal(mimeTypeForPath(path), "text/plain");
    assert.equal(isTextMime(mimeTypeForPath(path)), true);
  }
});
