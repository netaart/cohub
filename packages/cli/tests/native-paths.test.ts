import assert from "node:assert/strict";
import { test } from "node:test";
import { containsNativePath } from "../src/runtime/native/paths.js";

test("native containment follows Windows separators, drives and case sensitivity", () => {
  const root = "C:\\Users\\Alice\\project";
  for (const path of [root, `${root}\\sub`, "c:/users/alice/PROJECT/sub"]) assert(containsNativePath(root, path, "win32"), path);
  for (const path of [`${root}-other`, `${root}\\..\\other`, "D:\\Users\\Alice\\project\\sub"]) assert(!containsNativePath(root, path, "win32"), path);
  assert(containsNativePath("C:\\", root, "win32"));
  assert(containsNativePath("\\\\server\\share\\project", "\\\\SERVER\\share\\project\\sub", "win32"));
  assert(!containsNativePath("\\\\server\\share", "\\\\server\\other\\sub", "win32"));
});

test("native containment preserves Unix case sensitivity and path boundaries", () => {
  assert(containsNativePath("/project", "/project/sub", "linux"));
  assert(containsNativePath("/project/", "/project/sub", "darwin"));
  assert(containsNativePath("/", "/project", "linux"));
  for (const path of ["/Project/sub", "/project-other", "/project/../other"]) assert(!containsNativePath("/project", path, "linux"), path);
});
