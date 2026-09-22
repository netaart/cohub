import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function refreshInProcess(home: string, issuer: string) {
  const moduleUrl = new URL("../src/auth.ts", import.meta.url).href;
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `const {requireAccessToken}=await import(${JSON.stringify(moduleUrl)}); console.log(await requireAccessToken());`], {
      env: { ...process.env, HOME: home, ENV: "dev", COHUB_EXECUTION_TOKEN: "", COHUB_AUTH_ISSUER: issuer, COHUB_DEV_AUTH_ISSUER: issuer }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

test("concurrent local Runtimes rotate a refresh token once without losing the stored session", { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "rt-auth-"));
  let requests = 0;
  const server = createServer(async (_request, response) => {
    requests++;
    await delay(150);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const issuer = `http://127.0.0.1:${address.port}`;
  const directory = join(home, ".config", "cohub");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "auth.dev.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, env: "dev", issuer, clientId: "fixture", resource: "fixture", scope: "openid", tokenType: "Bearer", accessToken: "old-access", refreshToken: "old-refresh", accessTokenExpiresAt: 0, createdAt: 1, updatedAt: 1 }), { mode: 0o600 });
  try {
    const outcomes = await Promise.all([refreshInProcess(home, issuer), refreshInProcess(home, issuer)]);
    for (const outcome of outcomes) { assert.equal(outcome.code, 0, outcome.output); assert.match(outcome.output, /new-access/); }
    assert.equal(requests, 1);
    assert.equal(JSON.parse(await readFile(path, "utf8")).refreshToken, "new-refresh");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
