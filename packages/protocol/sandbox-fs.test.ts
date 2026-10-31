import assert from "node:assert/strict";
import { posix } from "node:path";
import { test } from "node:test";
import { assertSafeRelativePath, SpaceFsError } from "./src/fs/index.js";

test("normalizes relative paths like posix, without Node", () => {
  for (const input of ["a/b", "a//b/", "./a/./b", "a/../b", "a/b/..", "x/../../y", "a/b/../../..", "."]) {
    const expected = posix.normalize(input);
    if (expected === "." || expected === ".." || expected.startsWith("../")) {
      assert.throws(() => assertSafeRelativePath(input), SpaceFsError, input);
    } else {
      assert.equal(assertSafeRelativePath(input), expected, input);
    }
  }
  assert.equal(assertSafeRelativePath("a\\b"), "a/b");
  assert.equal(assertSafeRelativePath(".", { allowEmpty: true }), "");
  assert.throws(() => assertSafeRelativePath("/etc/passwd"), SpaceFsError);
});
