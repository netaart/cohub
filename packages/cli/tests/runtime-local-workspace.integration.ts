import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CohubHttpClient } from "@neta-art/cohub";
import { ownRuntimeInstance, runtimeInstanceDirectory } from "../src/runtime/instance.js";
import { connectLocalWorkspace, findLocalWorkspace, resolveLocalWorkspace } from "../src/runtime/local-workspace.js";
import type { RuntimeSummary } from "../src/runtime/presentation.js";
import { currentIdentityKey } from "../src/space.js";
import { uploadLocalFiles } from "../src/space-files/upload.js";

// Drives a real sandboxd the way the Runtime supervisor starts it, then talks to
// its loopback API through the SDK. Any request that reaches the API fails.
const hasGo = (() => { try { execFileSync("go", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const base = await mkdtemp(join(tmpdir(), "local-workspace-"));
const root = join(base, "workspace");
let bridge: ChildProcess | undefined;
let endpoint: { url: string; token: string };

before(async () => {
  if (!hasGo && !process.env.COHUB_SANDBOXD_BIN) return;
  const binary = process.env.COHUB_SANDBOXD_BIN ?? join(base, "sandboxd");
  if (!process.env.COHUB_SANDBOXD_BIN) {
    execFileSync("go", ["build", "-o", binary, "."], { cwd: fileURLToPath(new URL("../../../apps/sandbox", import.meta.url)), stdio: "inherit" });
  }
  await mkdir(root, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  bridge = spawn(binary, ["--local", "--space", randomUUID(), "--root", root, "--relay", "ws://127.0.0.1:9/sandbox/relay"], {
    stdio: ["pipe", "ignore", "ignore", "pipe"],
    env: { ...process.env, HOME: base, COHUB_RELAY_TOKEN: "unused", COHUB_LOCAL_TOKEN: token, COHUB_RUNTIME_MANAGED: "1", COHUB_DISPLAY: "test" },
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sandboxd did not report its loopback API")), 15_000);
    createInterface({ input: bridge?.stdio[3] as Readable }).on("line", (line) => {
      const event = JSON.parse(line) as { type: string; port?: number };
      if (event.type === "local" && event.port) { clearTimeout(timer); resolve(event.port); }
    });
  });
  endpoint = { url: `http://127.0.0.1:${port}`, token };
});

after(async () => {
  bridge?.kill("SIGTERM");
  await rm(base, { recursive: true, force: true });
});

const space = () => new CohubHttpClient({
  baseUrl: "https://api.invalid",
  fetch: async (input) => assert.fail(`reached the API: ${String(input)}`),
  localWorkspace: () => connectLocalWorkspace(endpoint),
}).space("space");

const skip = !hasGo && !process.env.COHUB_SANDBOXD_BIN ? "needs Go or COHUB_SANDBOXD_BIN" : false;

test("uploads stream from disk and never overwrite a file edited meanwhile", { skip }, async () => {
  const files = space().files;
  const source = join(base, "clip.bin");
  await writeFile(source, Buffer.alloc(3 * 1024 * 1024, 7));
  const { uploaded, uploadIds } = await uploadLocalFiles(files, [{ localPath: source, relativePath: "clip.bin", size: 3 * 1024 * 1024 }], { targetDir: "media" });
  assert.deepEqual([uploaded[0]?.path, uploaded[0]?.size, uploadIds], ["media/clip.bin", 3 * 1024 * 1024, []]);
  assert.deepEqual(await readFile(join(root, "media", "clip.bin")), await readFile(source));
  const workspace = await files.workspace();
  const body = new Blob(["edited elsewhere"]);
  await assert.rejects(workspace?.put?.("media/clip.bin", body, { exclusive: true }) as Promise<unknown>, { status: 409, code: "path_exists" });
  await assert.rejects(workspace?.put?.("media/clip.bin", body, { expected: { size: 1, mtimeMs: 1 } }) as Promise<unknown>, { status: 409, code: "file_conflict" });
});

test("the Runtime's token never reaches a configured proxy", { skip }, async () => {
  const seen: string[] = [];
  const proxy = createServer((request, response) => { seen.push(String(request.headers.authorization)); response.end("{}"); });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const script = `import { connectLocalWorkspace } from ${JSON.stringify(new URL("../src/runtime/local-workspace.ts", import.meta.url).href)};
    await connectLocalWorkspace(${JSON.stringify(endpoint)}).call("fs.stat", { path: "." });`;
  try {
    const child = spawn(process.execPath, ["--use-env-proxy", "--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, NO_PROXY: "" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    assert.equal((await once(child, "exit"))[0], 0);
    assert.deepEqual(seen, []);
  } finally {
    proxy.close();
  }
});

test("a ready Runtime hands its endpoint to the owner's processes only", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-workspace-owner-"));
  const saved = { HOME: process.env.HOME, COHUB_EXECUTION_TOKEN: process.env.COHUB_EXECUTION_TOKEN };
  const claims = Buffer.from(JSON.stringify({ actorUserId: "owner" })).toString("base64url");
  process.env.HOME = home;
  process.env.COHUB_EXECUTION_TOKEN = `e30.${claims}.sig`;
  const spaceId = randomUUID();
  let state: RuntimeSummary["state"] = "starting";
  const status = (): RuntimeSummary => ({ spaceId, runtimeId: "runtime", root: home, pid: process.pid, harnesses: [], state, harnessConnected: true, workspaceConnected: true, diagnosticsPath: home, background: true });
  const loopback = { url: "http://127.0.0.1:4321", token: "secret" };
  const identity = currentIdentityKey();
  assert.ok(identity);
  const instance = await ownRuntimeInstance(runtimeInstanceDirectory(identity, spaceId), status, async () => {}, async (action) => {
    if (action !== "workspace") throw new Error(action);
    return state === "ready" ? loopback : null;
  });
  try {
    assert.equal(await findLocalWorkspace(spaceId), null);
    state = "ready";
    assert.deepEqual(await findLocalWorkspace(spaceId), loopback);
    assert.equal(await resolveLocalWorkspace(spaceId), null, "a scoped execution token keeps the API");
  } finally {
    await instance.close();
    Object.assign(process.env, saved);
    if (saved.COHUB_EXECUTION_TOKEN === undefined) delete process.env.COHUB_EXECUTION_TOKEN;
    await rm(home, { recursive: true, force: true });
  }
});
