import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { exitCodeForChild } from "../src/launcher.js";
import { isNewerVersion, resolveSelfUpdateResult } from "../src/self-update.js";

test("self-update reinstalls only for a strictly newer release", () => {
  assert.equal(isNewerVersion("8.4.0", "8.4.0"), false);
  assert.equal(isNewerVersion("8.3.9", "8.4.0"), false);
  assert.equal(isNewerVersion("8.10.0", "8.9.0"), true);
  assert.equal(isNewerVersion("not a version", "8.4.0"), false);
});

test("self-update only relaunches when the installed version changes", () => {
  assert.equal(resolveSelfUpdateResult("3.8.1", "3.8.1", false), "current");
  assert.equal(resolveSelfUpdateResult("3.8.1", "3.9.0", false), "updated");
  assert.equal(resolveSelfUpdateResult("3.8.1", "3.9.0", true), "updated-by-peer");
});

test("self-update relaunches conservatively when a package version cannot be read", () => {
  assert.equal(resolveSelfUpdateResult(undefined, undefined, false), "updated");
  assert.equal(resolveSelfUpdateResult("3.8.1", undefined, true), "updated-by-peer");
});

test("updated CLI exit status is preserved", () => {
  assert.equal(exitCodeForChild(0, null), 0);
  assert.equal(exitCodeForChild(42, null), 42);
  assert.equal(exitCodeForChild(null, "SIGTERM"), 128 + constants.signals.SIGTERM);
  assert.equal(exitCodeForChild(null, null), 1);
});

test("termination signals sent to the launcher reach the updated CLI", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const launcherUrl = new URL("../src/launcher.ts", import.meta.url).href;
  const childPath = fileURLToPath(new URL("fixtures/terminable-child.mjs", import.meta.url));
  const source = `import { relaunchCli } from ${JSON.stringify(launcherUrl)}; process.exitCode = await relaunchCli(${JSON.stringify(childPath)}, []);`;
  const harness = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (harness.exitCode === null && harness.signalCode === null) harness.kill("SIGKILL");
  });

  let stdout = "";
  let stderr = "";
  harness.stdout.setEncoding("utf-8");
  harness.stderr.setEncoding("utf-8");
  harness.stdout.on("data", (chunk: string) => { stdout += chunk; });
  harness.stderr.on("data", (chunk: string) => { stderr += chunk; });

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: string) => {
      if (!chunk.includes("ready")) return;
      harness.stdout.off("data", onData);
      resolve();
    };
    harness.stdout.on("data", onData);
    harness.once("error", reject);
    harness.once("close", (code, signal) => reject(new Error(`launcher exited before child was ready (${signal ?? code})\n${stderr}`)));
  });

  assert.equal(harness.kill("SIGTERM"), true);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    harness.once("error", reject);
    harness.once("close", (code, signal) => resolve({ code, signal }));
  });

  assert.deepEqual(result, { code: 23, signal: null }, stderr);
  assert.match(stdout, /forwarded/);
});
