import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appHandlesFile,
  fileExtensionOf,
  MAX_APP_FILE_HANDLERS,
  normalizeFileExtension,
  parseAppFileHandlers,
} from "./src/app-file-handlers.js";

test("file extensions normalize to a lowercase dot-prefixed form", () => {
  assert.equal(normalizeFileExtension("board"), ".board");
  assert.equal(normalizeFileExtension(" .Board "), ".board");
  for (const value of ["", ".", "..board", ".a b", ".tar.gz", 1, null]) {
    assert.equal(normalizeFileExtension(value), null, String(value));
  }
});

test("declared handlers parse from a list or a meta content string", () => {
  assert.deepEqual(parseAppFileHandlers(".board, .MD  excalidraw .board"), [".board", ".md", ".excalidraw"]);
  assert.deepEqual(parseAppFileHandlers([".board", 3, "no way"]), [".board"]);
  assert.deepEqual(parseAppFileHandlers(undefined), []);
  const many = Array.from({ length: 50 }, (_, index) => `.x${index}`);
  assert.equal(parseAppFileHandlers(many).length, MAX_APP_FILE_HANDLERS);
});

test("a path's extension comes from its last segment; dotfiles have none", () => {
  assert.equal(fileExtensionOf("boards/Roadmap.BOARD"), ".board");
  assert.equal(fileExtensionOf("archive.v2/readme"), null);
  assert.equal(fileExtensionOf(".env"), null);
  assert.equal(fileExtensionOf("notes/"), null);
  assert.equal(appHandlesFile([".board"], "a/b.board"), true);
  assert.equal(appHandlesFile([".board"], "a/b.md"), false);
  assert.equal(appHandlesFile(undefined, "a/b.board"), false);
});
