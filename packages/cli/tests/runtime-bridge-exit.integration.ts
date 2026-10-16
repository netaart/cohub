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
import { readRuntimeDiagnosticEvents, type RuntimeDiagnostic } from "../src/runtime/diagnostics.js";
import { runRuntime } from "../src/runtime/supervisor.js";

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

async function stopDescendant(marker: string) {
  try { process.kill(JSON.parse(await readFile(marker, "utf8")).descendantPid, "SIGTERM"); }
  catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
}

for (const recover of [true, false]) test(`an exited bridge cannot hold Runtime ${recover ? "recovery" : "shutdown"} through a descendant's inherited pipes`, { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "rt-inherit-"));
  const fixture = await fixtureServer();
  const old = { ...process.env };
  const marker = join(root, "descendant.json");
  let directory: string | undefined;
  fixture.server.on("connection", (socket) => socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "runtime.hello") socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
    if (frame.type === "runtime.heartbeat") socket.send(JSON.stringify({ type: "runtime.heartbeat" }));
  }));
  try {
    process.env.HOME = root;
    process.env.CODEX_HOME = join(root, "codex");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi");
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "pi-sessions");
    process.env.COHUB_EXECUTION_TOKEN = `header.${Buffer.from(JSON.stringify({ actorUserId: "fixture-inherited-owner" })).toString("base64url")}.signature`;
    process.env.COHUB_WS_URL = fixture.url;
    process.env.COHUB_SANDBOXD_BIN = fileURLToPath(new URL("./fixtures/runtime-bridge-inherited.mjs", import.meta.url));
    process.env.COHUB_TEST_BRIDGE_INHERITED_MARKER = marker;
    const identity = currentIdentityKey(); assert(identity);
    const spaceId = crypto.randomUUID(); directory = runtimeInstanceDirectory(identity, spaceId);
    const summary = await startBackgroundRuntime({ spaceId, root, identity, harnesses: ["pi"], capabilities: { harnesses: ["pi"], models: [] }, executables: {}, background: true });
    const descendantPid = JSON.parse(await readFile(marker, "utf8")).descendantPid as number;
    if (!recover) {
      await delay(400);
      await requestRuntimeInstance(directory, "stop", true);
      for (let i = 0; i < 30 && await requestRuntimeInstance(directory); i++) await delay(100);
      assert.equal(await requestRuntimeInstance(directory), null, "stopping must not wait for a dead bridge's inherited streams");
      process.kill(descendantPid, 0);
      return;
    }
    let recovered = false;
    for (let i = 0; i < 50; i++) {
      const events = await readRuntimeDiagnosticEvents(join(root, ".local", "state", "cohub", "runtime", spaceId), { limit: 100 });
      if (events.filter((event) => event.event === "sandboxd.connected").length === 2) {
        assert(events.some((event) => event.event === "sandboxd.log" && event.data?.message === "last bridge diagnostic before exit"));
        recovered = true; break;
      }
      await delay(100);
    }
    assert.equal(recovered, true, "a dead bridge's inherited streams must not block its replacement");
    assert.equal((await requestRuntimeInstance(directory))?.pid, summary.pid);
    assert.equal((await requestRuntimeInstance(directory))?.runtimeId, summary.runtimeId);
    process.kill(descendantPid, 0);
    await requestRuntimeInstance(directory, "stop", true);
    for (let i = 0; i < 30 && await requestRuntimeInstance(directory); i++) await delay(100);
    assert.equal(await requestRuntimeInstance(directory), null, "shutdown releases IPC while the unrelated descendant is still alive");
    process.kill(descendantPid, 0);
  } finally {
    // This test alone owns the sleeper. Runtime must never signal it.
    await stopDescendant(marker);
    if (directory) await requestRuntimeInstance(directory, "stop", true).catch(() => undefined);
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    await fixture.close(); await rm(root, { recursive: true, force: true });
  }
});

test("a bridge spawn failure stays visible and shutdown does not wait for exit", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "rt-spawn-"));
  const fixture = await fixtureServer();
  const previous = { ...process.env };
  const controller = new AbortController();
  const events: RuntimeDiagnostic[] = [];
  const spaceId = crypto.randomUUID();
  let directory: string | undefined;
  fixture.server.on("connection", (socket) => socket.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "runtime.hello") socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
  }));
  try {
    process.env.HOME = root;
    process.env.CODEX_HOME = join(root, "codex");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi");
    process.env.COHUB_EXECUTION_TOKEN = `fixture.${Buffer.from(JSON.stringify({ sub: "spawn-test" })).toString("base64url")}.fixture`;
    process.env.COHUB_WS_URL = fixture.url;
    process.env.COHUB_SANDBOXD_BIN = join(root, "bridge");
    await writeFile(process.env.COHUB_SANDBOXD_BIN, `#!${root}/missing-interpreter\n`);
    await chmod(process.env.COHUB_SANDBOXD_BIN, 0o755);
    const identity = currentIdentityKey(); assert(identity);
    directory = runtimeInstanceDirectory(identity, spaceId);
    await runRuntime({ spaceId, root, identity, harnesses: ["pi"], capabilities: { harnesses: ["pi"], models: [] }, executables: {}, background: true }, () => {}, controller.signal, (event) => {
      events.push(event);
      if (event.event === "sandboxd.process_error") controller.abort();
    });
    assert(events.some((event) => event.event === "sandboxd.process_error" && event.error?.code === "ENOENT"));
    assert.equal(events.some((event) => ["runtime.available", "sandboxd.process_exit", "sandboxd.stdio_drain_timeout"].includes(event.event)), false);
    assert.equal(await requestRuntimeInstance(directory), null);
  } finally {
    controller.abort();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
