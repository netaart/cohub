import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validSandboxdArchiveEntries } from "../src/commands/sandboxd-binary.js";
import { harnessCommand } from "../src/runtime/harness.js";

// Verbatim cmd-shim 9 (npm) and @zkochan/cmd-shim 9 (pnpm) output for bin/codex.js.
const entry = "node_modules\\@openai\\codex\\bin\\codex.js";
const shims = {
  npm: [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
    `IF EXIST "%dp0%\\node.exe" (`, `  SET "_prog=%dp0%\\node.exe"`, ") ELSE (", `  SET "_prog=node"`, "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*`,
  ],
  pnpm: [
    "@SETLOCAL", `@IF EXIST "%~dp0\\node.exe" (`, `  "%~dp0\\node.exe"  "%~dp0\\${entry}" %*`, ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%", `  node  "%~dp0\\${entry}" %*`, ")",
  ],
};

for (const [manager, cmd] of Object.entries(shims)) {
  test(`${manager} shims run their Node entry directly`, { skip: process.platform !== "win32" }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "cohub-shim-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Both managers also write an extensionless sh script and a .ps1 next to the .cmd.
    await writeFile(join(directory, "codex"), `#!/bin/sh\nexec node "$basedir/${entry.replaceAll("\\", "/")}" "$@"\n`);
    await writeFile(join(directory, "codex.ps1"), "#!/usr/bin/env pwsh\n");
    await writeFile(join(directory, "codex.cmd"), cmd.join("\r\n"));
    const previous = process.env.PATH;
    process.env.PATH = directory;
    t.after(() => { process.env.PATH = previous; });
    assert.deepEqual(harnessCommand("codex", ["app-server"], directory), [process.execPath, [join(directory, entry), "app-server"]]);
  });
}

test("Windows sandboxd archives ship the .exe binary", () => {
  assert(validSandboxdArchiveEntries(["cohub-sandboxd.exe", "LICENSE", "NOTICE"], "windows"));
  assert.equal(validSandboxdArchiveEntries(["cohub-sandboxd", "LICENSE", "NOTICE"], "windows"), false);
  assert(validSandboxdArchiveEntries(["cohub-sandboxd", "LICENSE", "NOTICE"], "linux"));
});
