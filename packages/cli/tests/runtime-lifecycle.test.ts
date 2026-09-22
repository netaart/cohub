import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { installedHarnesses, harnessExecutableCandidates } from "../src/runtime/harness.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerRuntime } from "../src/commands/runtime.js";
import { createDiagnosticConsole } from "../src/runtime/presentation.js";
import { sandboxOutputLevel } from "../src/runtime/supervisor.js";
import { RuntimeDiagnostics, readRuntimeDiagnosticEvents } from "../src/runtime/diagnostics.js";
import { resolveRuntimeSpace } from "../src/runtime/space-binding.js";

test("-n is a boolean alias for --new; name and detach remain explicit", () => {
  const program = new Command(); registerRuntime(program);
  const up = program.commands[0]?.commands.find((item) => item.name() === "up");
  assert(up);
  const option = up.options.find((item) => item.short === "-n");
  assert.equal(option?.long, "--new");
  assert.equal(option?.required, false);
  assert(up.options.some((item) => item.long === "--detach" && item.short === "-d"));
  assert(up.options.some((item) => item.long === "--name" && item.required));
});

test("ordinary up discovers installed Harnesses without defaulting to an absent Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-bins-"));
  try {
    assert.deepEqual(await installedHarnesses(root, {}, root), []);
    await writeFile(join(root, "codex"), "#!/bin/sh\n", { mode: 0o700 });
    assert.deepEqual(await installedHarnesses(root, {}, root), ["codex"]);
    await writeFile(join(root, "pi"), "#!/bin/sh\n", { mode: 0o700 });
    assert.deepEqual(await installedHarnesses(root, {}, root), ["pi", "codex"]);
    await chmod(join(root, "pi"), 0o600);
    assert.deepEqual(await installedHarnesses(root, {}, root), ["codex"]);
    assert.deepEqual(await installedHarnesses(root, { codex: "./codex" }, ""), ["codex"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows discovery respects PATHEXT, quoted PATH entries and explicit extensions", () => {
  assert.deepEqual(harnessExecutableCandidates("pi", "C:\\work", '"C:\\Program Files\\node";D:\\bin', "win32", ".EXE;.CMD"), [
    "C:\\Program Files\\node\\pi", "C:\\Program Files\\node\\pi.EXE", "C:\\Program Files\\node\\pi.CMD",
    "D:\\bin\\pi", "D:\\bin\\pi.EXE", "D:\\bin\\pi.CMD",
  ]);
  assert.deepEqual(harnessExecutableCandidates(".\\codex.exe", "C:\\work", "", "win32", ".EXE;.CMD"), ["C:\\work\\codex.exe"]);
  assert(harnessExecutableCandidates("codex", "C:\\work", "D:\\bin", "win32", "").includes("D:\\bin\\codex.CMD"));
});

test("stderr does not override a structured sandbox log level", () => {
  assert.equal(sandboxOutputLevel("INFO", "stderr"), "info");
  assert.equal(sandboxOutputLevel("DEBUG", "stderr"), "debug");
  assert.equal(sandboxOutputLevel("WARN", "stdout"), "warn");
  assert.equal(sandboxOutputLevel(undefined, "stderr"), "warn");
});

test("terminal diagnostics are redacted and throttled, while disk retains every event", async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-log-"));
  const lines: string[] = [];
  const diagnostics = new RuntimeDiagnostics({ root, spaceId: "space", onEvent: createDiagnosticConsole(false, (line) => lines.push(line)) });
  try {
    diagnostics.log("debug", "runtime.noise");
    diagnostics.log("warn", "runtime.auth_token_failed", { error: new Error("Bearer credential-secret") });
    diagnostics.log("warn", "runtime.auth_token_failed", { error: new Error("Bearer credential-secret") });
    diagnostics.log("info", "runtime.available");
    await diagnostics.close();
    assert.equal(lines.length, 2);
    assert(lines.some((line) => line.includes("已就绪")));
    assert(!lines.join("").includes("credential-secret"));
    assert.equal((await readRuntimeDiagnosticEvents(root, { limit: 10 })).length, 4);
  } finally { await diagnostics.close(); await rm(root, { recursive: true, force: true }); }
});

test("new Space selection preserves old state and detects concurrent rebinding", async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-new-"));
  const path = join(root, "config", "runtime-spaces.json");
  try {
    const input = { root, path, identityKey: "prod:test", createSpace: async () => "first" };
    await resolveRuntimeSpace(input);
    const created = await resolveRuntimeSpace({ ...input, newSpace: true, expectedSpaceId: "first", createSpace: async () => "second" });
    assert.equal(created.spaceId, "second");
    await assert.rejects(resolveRuntimeSpace({ ...input, newSpace: true, expectedSpaceId: "first" }), /binding changed/);
    assert.equal((await resolveRuntimeSpace(input)).spaceId, "second");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ambiguous remote creation never replays; explicit binding retains the receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-receipt-"));
  const path = join(root, "config", "runtime-spaces.json");
  await mkdir(join(root, "config"));
  let calls = 0;
  const input = { root, path, identityKey: "prod:test", createSpace: async () => { calls++; throw new Error("network lost after create"); } };
  try {
    await assert.rejects(resolveRuntimeSpace(input), /network lost/);
    await assert.rejects(resolveRuntimeSpace(input), /unknown outcome/);
    assert.equal(calls, 1);
    await resolveRuntimeSpace({ ...input, explicitSpaceId: "recovered" });
    const receipts = (await readdir(join(root, "config"))).filter((name) => name.endsWith(".resolved"));
    assert.equal(receipts.length, 1);
    assert(receipts[0]);
    assert(JSON.parse(await readFile(join(root, "config", receipts[0]), "utf8")).operationId);
  } finally { await rm(root, { recursive: true, force: true }); }
});
