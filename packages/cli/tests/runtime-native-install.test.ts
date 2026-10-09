import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { repairIntegrations } from "../src/runtime/native/attach.js";
import { installPiExtension, piExtensionState } from "../src/runtime/native/install.js";

// The re-export CLI 8.0–8.2 installed as `cohub.ts`, the path tests (run from source) install to.
const LEGACY = '// Cohub native Turn sync\nexport { default } from "file:///gone/native-pi-extension.js";\n';
const previous = { pi: process.env.PI_CODING_AGENT_DIR, codex: process.env.CODEX_HOME };
let home: string;
let extensions: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cohub-integrations-"));
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  process.env.CODEX_HOME = join(home, "codex");
  extensions = join(home, "agent", "extensions");
  await mkdir(extensions, { recursive: true });
});

afterEach(async () => {
  for (const [key, value] of [["PI_CODING_AGENT_DIR", previous.pi], ["CODEX_HOME", previous.codex]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

/** A Pi that only reports its version; `pi --version` answers before Pi loads extensions. */
async function fakePi() {
  const pi = join(home, "pi");
  await writeFile(pi, "#!/bin/sh\necho 0.87.1\n");
  await chmod(pi, 0o755);
  return pi;
}

test("a legacy Pi extension is outdated and replaced on install", async () => {
  await writeFile(join(extensions, "cohub.ts"), LEGACY);
  await writeFile(join(extensions, "cohub.js"), LEGACY);
  assert.equal(await piExtensionState(), "outdated");
  await installPiExtension();
  assert.equal(await piExtensionState(), "installed");
  assert.deepEqual(await readdir(extensions), ["cohub.ts"]);
});

test("runtime up repairs a legacy Pi extension before Pi starts, and installs none without consent", async () => {
  const pi = await fakePi();
  const lines: string[] = [];
  await repairIntegrations(pi, (line) => lines.push(line));
  assert.deepEqual(await readdir(extensions), []);
  assert(!(await readdir(home)).includes("codex"), "no Codex directory appears");

  await writeFile(join(extensions, "cohub.ts"), LEGACY);
  await repairIntegrations(pi, (line) => lines.push(line));
  assert.equal(await piExtensionState(), "installed");
  assert.match(await readFile(join(extensions, "cohub.ts"), "utf8"), /^\/\/ Cohub control extension for Pi/);
  assert.deepEqual(lines, ["Pi extension updated; run /reload in open Pi sessions\n"]);
});

test("runtime up removes legacy Codex hooks and keeps the rest of the config", async () => {
  const config = join(home, "codex", "config.toml");
  await mkdir(join(home, "codex"));
  await writeFile(config, 'model = "gpt-5"\n\n# BEGIN COHUB NATIVE SYNC\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "node /gone/native-codex-hook.js"\n# END COHUB NATIVE SYNC\n');
  await repairIntegrations(await fakePi(), () => undefined);
  assert.equal(await readFile(config, "utf8"), 'model = "gpt-5"\n');
});
