import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessCommand } from "../src/runtime/harness.js";

test("npm .cmd shims run their Node entry directly", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cohub-shim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "codex.cmd"), [
    "@ECHO off", "SETLOCAL", "CALL :find_dp0",
    `IF EXIST "%dp0%\\node.exe" (`, `  SET "_prog=%dp0%\\node.exe"`, ") ELSE (", `  SET "_prog=node"`, ")",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*`,
  ].join("\r\n"));
  const previous = process.env.PATH;
  process.env.PATH = directory;
  t.after(() => { process.env.PATH = previous; });
  assert.deepEqual(harnessCommand("codex", ["app-server"], directory), [
    process.execPath,
    [join(directory, "node_modules", "@openai", "codex", "bin", "codex.js"), "app-server"],
  ]);
});
