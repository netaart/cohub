import { nativeFixtureHome } from "./fixtures/native-home.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmod, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { startBackgroundRuntime } from "../src/runtime/launch.js";
import { requestRuntimeInstance, runtimeInstanceDirectory } from "../src/runtime/instance.js";
import { currentIdentityKey } from "../src/space.js";

after(() => rm(nativeFixtureHome, { recursive: true, force: true }));

async function fixtureServer() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return { server, url: `ws://127.0.0.1:${address.port}`, close: async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

test("a disconnected bridge recovers after the Harness lease returns without replacing a connected bridge or Runtime", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "rt-lease-"));
  const fixture = await fixtureServer();
  const old = { ...process.env };
  let directory: string | undefined;
  let connections = 0;
  let currentSocket: import("ws").WebSocket | undefined;
  const socket = () => { assert(currentSocket); return currentSocket; };
  let allowReady = true;
  fixture.server.on("connection", (socket) => {
    connections++; currentSocket = socket;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "runtime.hello" && allowReady) socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
      if (frame.type === "runtime.heartbeat") socket.send(JSON.stringify({ type: "runtime.heartbeat" }));
    });
  });
  const waitFor = async (condition: () => Promise<boolean>, message: string) => {
    for (let i = 0; i < 800; i++) { if (await condition()) return; await delay(50); }
    assert.fail(message);
  };
  try {
    process.env.HOME = root;
    process.env.CODEX_HOME = join(root, "codex");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi");
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "pi-sessions");
    process.env.COHUB_EXECUTION_TOKEN = `header.${Buffer.from(JSON.stringify({ actorUserId: "fixture-lease-owner" })).toString("base64url")}.signature`;
    process.env.COHUB_WS_URL = fixture.url;
    process.env.COHUB_SANDBOXD_BIN = fileURLToPath(new URL("./fixtures/runtime-bridge-lease.mjs", import.meta.url));
    const marker = join(root, "bridge-disconnected");
    process.env.COHUB_TEST_BRIDGE_DISCONNECT_MARKER = marker;
    await chmod(process.env.COHUB_SANDBOXD_BIN, 0o755);
    const identity = currentIdentityKey(); assert(identity);
    const spaceId = crypto.randomUUID();
    const instanceDirectory = runtimeInstanceDirectory(identity, spaceId);
    directory = instanceDirectory;
    const summary = await startBackgroundRuntime({ spaceId, root, identity, harnesses: ["pi"], capabilities: { harnesses: ["pi"], models: [] }, executables: {}, background: true });
    const pids = async () => (await readFile(`${marker}.pids`, "utf8")).trim().split("\n");
    assert.equal((await pids()).length, 1);
    const originalBridge = (await pids())[0];
    socket().terminate();
    await waitFor(async () => connections >= 2 && (await requestRuntimeInstance(instanceDirectory))?.harnessConnected === true, "Harness did not reconnect");
    assert.deepEqual(await pids(), [originalBridge], "a still-connected bridge survives Harness renewal");
    await writeFile(marker, "recover");
    await waitFor(async () => (await requestRuntimeInstance(instanceDirectory))?.workspaceConnected === false, "bridge did not begin normal recovery");
    await waitFor(async () => (await requestRuntimeInstance(instanceDirectory))?.workspaceConnected === true, "bridge did not complete normal recovery");
    assert.deepEqual(await pids(), [originalBridge], "normal bridge retries must not be interrupted");
    allowReady = false;
    socket().terminate();
    await waitFor(async () => (await requestRuntimeInstance(instanceDirectory))?.harnessConnected === false, "Harness did not disconnect");
    await writeFile(marker, "simulate file bridge lease rejection");
    await rm(`${marker}.handled`);
    await waitFor(async () => (await requestRuntimeInstance(instanceDirectory))?.workspaceConnected === false, "bridge did not report disconnected");
    await delay(31_000);
    assert.deepEqual(await pids(), [originalBridge], "a bridge cannot restart before the Harness lease is ready");
    await waitFor(async () => connections >= 3, "Harness did not retry");
    allowReady = true;
    socket().send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
    await delay(1000);
    assert.deepEqual(await pids(), [originalBridge], "the disconnected bridge gets a recovery grace period");
    await delay(14_000);
    allowReady = false;
    socket().terminate();
    await waitFor(async () => (await requestRuntimeInstance(instanceDirectory))?.harnessConnected === false && connections >= 4, "Harness did not disconnect during bridge recovery");
    await delay(5000);
    assert.deepEqual(await pids(), [originalBridge]);
    allowReady = true;
    const leaseReadyAt = Date.now();
    socket().send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
    await waitFor(async () => (await pids()).length === 2 && (await requestRuntimeInstance(instanceDirectory))?.state === "ready", "disconnected bridge remained stuck after Harness lease renewal");
    assert(Date.now() - leaseReadyAt >= 29_000, "a renewed lease must receive a fresh recovery grace period");
    const recovered = await requestRuntimeInstance(directory);
    assert.equal(recovered?.pid, summary.pid);
    assert.equal(recovered?.runtimeId, summary.runtimeId);
    assert.notEqual((await pids())[1], originalBridge);
    await delay(300);
    assert.equal((await pids()).length, 2, "recovery must not create additional bridge processes");
    // Exercise the opposite event order: the Harness is already ready when
    // the bridge reports its lease rejection.
    await rm(`${marker}.handled`);
    await waitFor(async () => (await pids()).length === 3 && (await requestRuntimeInstance(instanceDirectory))?.state === "ready", "a late bridge disconnect did not recover with an already-ready Harness");
    assert.equal((await requestRuntimeInstance(directory))?.pid, summary.pid);
    assert.equal((await requestRuntimeInstance(directory))?.runtimeId, summary.runtimeId);
    await delay(300);
    assert.equal((await pids()).length, 3);
  } finally {
    if (directory) await requestRuntimeInstance(directory, "stop", true).catch(() => undefined);
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    await fixture.close(); await rm(root, { recursive: true, force: true });
  }
});
