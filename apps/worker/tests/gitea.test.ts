import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { config } from "../src/config.js";
import { mirrorRepositoryToGitea } from "../src/gitea.js";
import { runGitWithOutput } from "../src/checkpoint/git.js";

test("Gitea push keeps credentials out of argv and repository config, including on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cohub-gitea-test-"));
  const original = { giteaBaseUrl: config.giteaBaseUrl, giteaToken: config.giteaToken, giteaOrg: config.giteaOrg };
  const originalPath = process.env.PATH;
  const token = "test-only-secret";
  const credentials = Buffer.from(`x-access-token:${token}`).toString("base64");
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  t.after(async () => {
    Object.assign(config, original);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  });
  Object.assign(config, { giteaBaseUrl: "https://git.example.com", giteaToken: token, giteaOrg: "spaces" });

  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const capture = join(root, "push.json");
  await mkdir(repo);
  await mkdir(bin);
  execFileSync(git, ["init", "-q", repo]);
  // The shim delegates local Git operations to real Git, but never contacts a remote.
  await writeFile(join(bin, "git"), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { writeFileSync, existsSync } = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('push')) {
  const result = spawnSync(${JSON.stringify(git)}, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, header: process.env.COHUB_GIT_AUTH_HEADER }));
if (existsSync(${JSON.stringify(join(root, "fail"))})) {
  console.error(process.env.COHUB_GIT_AUTH_HEADER, ${JSON.stringify(token)});
  process.exit(1);
}
`, { mode: 0o700 });
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 201 }));

  for (const fail of [false, true]) {
    // Simulate a credential-bearing remote left by an old worker.
    execFileSync(git, ["remote", "add", "cohub", `https://x-access-token:${token}@git.example.com/old.git`], { cwd: repo });
    if (fail) await writeFile(join(root, "fail"), "");
    const push = mirrorRepositoryToGitea(repo, "space-1", "main");
    if (fail) {
      await assert.rejects(push, (error: Error) => {
        assert.ok(!error.message.includes(token));
        assert.ok(!error.message.includes(credentials));
        assert.match(error.message, /\*\*\*/);
        return true;
      });
    } else {
      await push;
    }
    const invocation = JSON.parse(await readFile(capture, "utf8"));
    assert.deepEqual(invocation.args.slice(-4), ["push", "--", "https://git.example.com/spaces/space-1.git", "main"]);
    assert.ok(!JSON.stringify(invocation.args).includes(token));
    assert.ok(!JSON.stringify(invocation.args).includes(credentials));
    assert.equal(invocation.header, `Authorization: Basic ${credentials}`);
    assert.ok(invocation.args.includes("--config-env=http.extraHeader=COHUB_GIT_AUTH_HEADER"));
    assert.ok(invocation.args.includes("http.followRedirects=false"));
    assert.ok(invocation.args.includes("credential.helper="));
    const persisted = await readFile(join(repo, ".git", "config"), "utf8");
    assert.ok(!persisted.includes(token));
    assert.ok(!persisted.includes(credentials));
    assert.ok(!persisted.includes('[remote "cohub"]'));
  }

  // Verify real Git understands config-env without persisting the header.
  const output = await runGitWithOutput([
    "--config-env=http.extraHeader=COHUB_GIT_AUTH_HEADER", "config", "--get", "http.extraHeader",
  ], repo, { env: { COHUB_GIT_AUTH_HEADER: `Authorization: Basic ${credentials}` }, redact: [credentials] });
  assert.equal(output.stdout.trim(), "Authorization: Basic ***");
});
