import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureNativeSync } from "../src/runtime/native/attach.js";
import { nativeConfigPath, runtimeStateRoot, writeNativeConfig, type NativeConfig } from "../src/runtime/native/config.js";

test("existing native sync can enable shared Codex without renewing sync or importing history", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "cohub-consent-"));
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const binary = join(home, "codex.mjs");
  const input = { root: home, spaceId: "space", identity: "test", harnesses: ["codex"] as ["codex"], executables: { codex: binary } };
  const initial: NativeConfig = { version: 2, root: home, spaceId: input.spaceId, identity: input.identity, harnesses: ["codex"], enabledAt: "2026-01-01T00:00:00.000Z", codexShared: false };
  const stateRoot = runtimeStateRoot(input.spaceId);
  try {
    for (const scenario of [
      { name: "explicit --yes upgrades an existing private configuration", yes: true, interactive: false, answer: false, shared: false, version: "0.163.0", expected: true, questions: 0 },
      { name: "interactive consent asks only about shared control", yes: false, interactive: true, answer: true, shared: false, version: "0.163.0", expected: true, questions: 1 },
      { name: "declining preserves existing sync", yes: false, interactive: true, answer: false, shared: false, version: "0.163.0", expected: false, questions: 1 },
      { name: "unattended reuse never grants new consent", yes: false, interactive: false, answer: true, shared: false, version: "0.163.0", expected: false, questions: 0 },
      { name: "shared consent remains idempotent", yes: true, interactive: true, answer: false, shared: true, version: "0.163.0", expected: true, questions: 0 },
      { name: "unsupported Codex stays private", yes: true, interactive: true, answer: true, shared: false, version: "0.155.0", expected: false, questions: 0 },
    ]) {
      await t.test(scenario.name, async () => {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: scenario.interactive });
        await writeFile(binary, `#!/usr/bin/env node\nconsole.log("codex-cli ${scenario.version}");\n`, { mode: 0o700 });
        const before = { ...initial, codexShared: scenario.shared };
        await writeNativeConfig(stateRoot, before);
        const questions: string[] = [];
        const report = await ensureNativeSync({ ...input, yes: scenario.yes }, () => {}, async (question) => {
          questions.push(question);
          return scenario.answer;
        });
        const expected = scenario.shared || process.platform !== "win32" && scenario.expected;
        assert.deepEqual(report, { enabled: true, harnesses: ["codex"], codexShared: expected, importHistory: false });
        assert.equal(questions.length, process.platform === "win32" ? 0 : scenario.questions);
        for (const question of questions) assert.match(question, /same live sessions/);
        assert.deepEqual(JSON.parse(await readFile(nativeConfigPath(stateRoot), "utf8")), { ...before, codexShared: expected });
      });
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else Reflect.deleteProperty(process.stdin, "isTTY");
    await rm(home, { recursive: true, force: true });
  }
});
