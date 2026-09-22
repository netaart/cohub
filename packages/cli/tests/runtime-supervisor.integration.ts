import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { serveRuntime } from "../src/runtime/connection.js";
import { startBackgroundRuntime } from "../src/runtime/launch.js";
import { ownRuntimeInstance, requestRuntimeInstance, runtimeInstanceDirectory } from "../src/runtime/instance.js";
import type { RuntimeSummary } from "../src/runtime/presentation.js";
import { currentIdentityKey } from "../src/space.js";
import { TestRuntimeSessionStore } from "./fixtures/runtime-projection-source.js";
import { readRuntimeDiagnosticEvents, RuntimeDiagnostics } from "../src/runtime/diagnostics.js";
import { runRuntime } from "../src/runtime/supervisor.js";
import { createServer } from "node:net";

test("instance IPC reuses one owner and refuses to stop unconfirmed work implicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rt-ipc-"));
  const status: RuntimeSummary = { spaceId: "space", runtimeId: "runtime", root: directory, pid: process.pid, harnesses: ["pi"], state: "ready", harnessConnected: true, workspaceConnected: true, diagnosticsPath: directory, background: false };
  let stopped = false;
  const close = await ownRuntimeInstance(directory, () => status, async (force) => {
    if (!force) throw new Error("Unconfirmed executions remain");
    stopped = true;
  });
  try {
    assert.deepEqual(await requestRuntimeInstance(directory), status);
    await assert.rejects(ownRuntimeInstance(directory, () => status, async () => {}), /already running/);
    await assert.rejects(requestRuntimeInstance(directory, "stop"), /Unconfirmed/);
    assert.equal(stopped, false);
    await requestRuntimeInstance(directory, "stop", true);
    assert.equal(stopped, true);
  } finally { await close(); assert.equal(await requestRuntimeInstance(directory), null); await rm(directory, { recursive: true, force: true }); }
});

test("a reused live PID with a missing control socket can be reclaimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rt-stale-pid-"));
  await writeFile(join(directory, "owner.json"), JSON.stringify({ pid: process.pid, nonce: "old", socket: join(directory, "missing.sock") }));
  const status: RuntimeSummary = { spaceId: "space", runtimeId: "new", root: directory, pid: process.pid, harnesses: ["pi"], state: "ready", harnessConnected: true, workspaceConnected: true, diagnosticsPath: directory, background: false };
  try {
    assert.equal(await requestRuntimeInstance(directory), null);
    const close = await ownRuntimeInstance(directory, () => status, async () => {});
    try { assert.equal((await requestRuntimeInstance(directory))?.runtimeId, "new"); }
    finally { await close(); }
    assert.equal(await requestRuntimeInstance(directory), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an unauthenticated live control socket is never reclaimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rt-foreign-ipc-"));
  const socket = join(directory, "control.sock");
  const owner = JSON.stringify({ pid: process.pid, nonce: "expected", socket });
  const server = createServer((client) => client.once("data", () => client.end(`${JSON.stringify({ nonce: "other", status: { pid: process.pid } })}\n`)));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await writeFile(join(directory, "owner.json"), owner);
  try {
    await assert.rejects(ownRuntimeInstance(directory, () => { throw new Error("unused"); }, async () => {}), /identity changed/);
    assert.equal(await readFile(join(directory, "owner.json"), "utf8"), owner);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostic close failure still releases the instance and signal handlers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rt-cleanup-"));
  const oldHome = process.env.HOME;
  const oldBinary = process.env.COHUB_SANDBOXD_BIN;
  process.env.HOME = root;
  process.env.COHUB_SANDBOXD_BIN = fileURLToPath(new URL("./fixtures/runtime-bridge.mjs", import.meta.url));
  const counts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const originalClose = RuntimeDiagnostics.prototype.close;
  t.mock.method(RuntimeDiagnostics.prototype, "close", async function (this: RuntimeDiagnostics) { await originalClose.call(this); throw new Error("disk flush failed"); });
  const controller = new AbortController();
  const spaceId = crypto.randomUUID(), identity = "fixture-cleanup";
  try {
    await assert.rejects(runRuntime({ spaceId, root, identity, harnesses: ["pi"], capabilities: { harnesses: ["pi"], models: [] }, executables: {}, background: true }, () => controller.abort(), controller.signal), /disk flush failed/);
    assert.equal(await requestRuntimeInstance(runtimeInstanceDirectory(identity, spaceId)), null);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], counts);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldBinary === undefined) delete process.env.COHUB_SANDBOXD_BIN; else process.env.COHUB_SANDBOXD_BIN = oldBinary;
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureServer() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return { server, url: `ws://127.0.0.1:${address.port}`, close: async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

test("credential network failures and rejected access tokens recover without restarting Runtime", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-retry-"));
  const fixture = await fixtureServer();
  const controller = new AbortController();
  let attempts = 0, connections = 0, refreshes = 0;
  let ready!: () => void;
  const connected = new Promise<void>((resolve) => { ready = resolve; });
  fixture.server.on("connection", (socket) => {
    connections++;
    socket.on("message", () => {
      if (connections === 1) socket.close(4401, "token expired");
      else socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
    });
  });
  const spaceId = crypto.randomUUID();
  const running = serveRuntime({ spaceId, cwd: root, url: fixture.url, capabilities: { harnesses: ["pi"], models: [] }, harnesses: {},
    token: async (force) => { if (force) refreshes++; if (++attempts < 3) throw new TypeError("fetch failed"); return "fixture"; },
    signal: controller.signal, store: new TestRuntimeSessionStore(spaceId, root), onReady: ready,
  });
  try { await connected; assert(attempts >= 4); assert.equal(refreshes, 1); assert.equal(connections, 2); }
  finally { controller.abort(); await running; await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("detached Runtime confirms both components, survives bridge exit, and stops through authenticated IPC", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-daemon-"));
  const fixture = await fixtureServer();
  const old = { ...process.env };
  let directory: string | undefined;
  fixture.server.on("connection", (socket) => socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "runtime.hello") socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
    if (frame.type === "runtime.heartbeat") socket.send(JSON.stringify({ type: "runtime.heartbeat" }));
  }));
  try {
    process.env.HOME = root;
    process.env.COHUB_EXECUTION_TOKEN = `header.${Buffer.from(JSON.stringify({ actorUserId: "fixture-owner" })).toString("base64url")}.signature`;
    process.env.COHUB_WS_URL = fixture.url;
    process.env.COHUB_SANDBOXD_BIN = fileURLToPath(new URL("./fixtures/runtime-bridge.mjs", import.meta.url));
    process.env.COHUB_TEST_BRIDGE_EXIT_MARKER = join(root, "bridge-exited");
    await chmod(process.env.COHUB_SANDBOXD_BIN, 0o755);
    const identity = currentIdentityKey(); assert(identity);
    const spaceId = crypto.randomUUID();
    directory = runtimeInstanceDirectory(identity, spaceId);
    const summary = await startBackgroundRuntime({ spaceId, root, identity, harnesses: ["pi"], capabilities: { harnesses: ["pi"], models: [] }, executables: {}, background: true });
    assert.equal(summary.state, "ready");
    assert(summary.harnessConnected && summary.workspaceConnected);
    assert.notEqual(summary.pid, process.pid);
    await delay(2200);
    const current = await requestRuntimeInstance(directory);
    assert.equal(current?.state, "ready");
    assert.equal(current?.pid, summary.pid, "only the crashed bridge restarts, not the supervisor");
    const events = await readRuntimeDiagnosticEvents(join(root, ".local", "state", "cohub", "runtime", spaceId), { limit: 100 });
    assert(events.some((event) => event.event === "sandboxd.process_exit"));
    assert.equal(events.filter((event) => event.event === "sandboxd.connected").length, 2);
    await requestRuntimeInstance(directory, "stop", true);
    for (let i = 0; i < 40; i++) {
      if (!await requestRuntimeInstance(directory).catch(() => true)) break;
      await delay(100);
    }
    assert.equal(await requestRuntimeInstance(directory), null);
  } finally {
    if (directory) await requestRuntimeInstance(directory, "stop", true).catch(() => undefined);
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    await fixture.close(); await rm(root, { recursive: true, force: true });
  }
});
