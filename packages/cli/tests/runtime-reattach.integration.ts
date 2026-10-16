import { nativeFixtureHome } from "./fixtures/native-home.js";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Command } from "commander";
import { runtimeUp } from "../src/runtime/launch.js";
import { currentIdentityKey } from "../src/space.js";
import { ownRuntimeInstance, runtimeInstanceDirectory } from "../src/runtime/instance.js";
import { runtimeStateRoot, writeNativeConfig } from "../src/runtime/native/config.js";
import type { RuntimeSummary } from "../src/runtime/presentation.js";

after(() => rm(nativeFixtureHome, { recursive: true, force: true }));

for (const action of ["reload", "import"] as const) for (const outcome of ["error", "stopped", "success"] as const) {
  test(`reattaching reports ${action} ${outcome} instead of the old ready state`, async (t) => {
    const root = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "rt-reattach-")));
    const previous = { ...process.env };
    process.env.HOME = root;
    process.env.CODEX_HOME = join(root, "codex");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi");
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "history");
    process.env.COHUB_EXECUTION_TOKEN = `fixture.${Buffer.from(JSON.stringify({ sub: "reattach-test" })).toString("base64url")}.fixture`;
    const spaceId = crypto.randomUUID();
    const identity = currentIdentityKey(); assert(identity);
    const directory = runtimeInstanceDirectory(identity, spaceId);
    const harnesses = [action === "import" ? "pi" : "codex"] as ("pi" | "codex")[];
    let summary: RuntimeSummary = { spaceId, runtimeId: "fixture-runtime", root, harnesses, pid: process.pid, state: "ready", harnessConnected: true, workspaceConnected: true, diagnosticsPath: join(root, "diagnostics"), background: true };
    const actions: string[] = [];
    let removeOwner = outcome === "stopped" && action === "reload";
    const close = await ownRuntimeInstance(directory, () => {
      if (removeOwner) { unlinkSync(join(directory, "owner.json")); removeOwner = false; }
      return summary;
    }, async () => {}, async (requested) => {
      actions.push(requested);
      if (requested === action && outcome === "error") throw new Error(`Native ${action} failed: damaged sync configuration`);
      if (requested === "reload") {
        summary = { ...summary, state: "reconnecting", workspaceConnected: false };
        if (action === "import" && outcome === "stopped") removeOwner = true;
      } else if (requested === "import") summary = { ...summary, state: "attention", harnessConnected: false };
    });
    try {
      if (action === "reload") {
        await writeNativeConfig(runtimeStateRoot(spaceId), { version: 2, identity, spaceId, root, harnesses, enabledAt: "2025-01-01T00:00:00.000Z", codexShared: false });
      } else {
        const bin = join(root, "bin");
        await mkdir(bin);
        const pi = fileURLToPath(new URL("./fixtures/runtime-pi.mjs", import.meta.url));
        await chmod(pi, 0o755);
        await symlink(pi, join(bin, "pi"));
        process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${previous.PATH}`;
        await mkdir(process.env.PI_CODING_AGENT_SESSION_DIR);
        const history = join(process.env.PI_CODING_AGENT_SESSION_DIR, "earlier.jsonl");
        await writeFile(history, `${JSON.stringify({ type: "session", id: "earlier", cwd: root })}\n`);
        await utimes(history, new Date("2025-01-01"), new Date("2025-01-01"));
      }
      t.mock.method(globalThis, "fetch", async () => { throw new Error("Network is forbidden in this fixture"); });
      const output: string[] = [];
      const stdout = t.mock.method(process.stdout, "write", (chunk) => { output.push(String(chunk)); return true; });
      try {
        const reattach = runtimeUp(new Command(), root, { space: spaceId, harness: harnesses, yes: true, json: true });
        if (outcome === "success") await reattach;
        else await assert.rejects(reattach, outcome === "error" ? new RegExp(`Native ${action} failed: damaged sync configuration`) : new RegExp(`Runtime stopped before ${action === "reload" ? "native sync could reload" : "history import could start"}`));
      } finally { stdout.mock.restore(); }
      assert.deepEqual(actions, action === "reload" ? outcome === "stopped" ? [] : ["reload"] : outcome === "stopped" ? ["reload"] : ["reload", "import"]);
      if (outcome === "success") {
        const printed = JSON.parse(output.join(""));
        assert.equal(printed.state, action === "reload" ? "reconnecting" : "attention");
        assert.equal(printed.workspaceConnected, false);
        assert.equal(printed.harnessConnected, action === "reload");
        assert.equal(printed.runtimeId, summary.runtimeId);
        assert.equal(printed.reused, true);
      } else assert.deepEqual(output, []);
    } finally {
      await close();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  });
}
