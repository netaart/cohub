import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { requestRuntimeUpdate, RUNTIME_HANDOFF_ENV } from "../src/runtime/detached.js";
import { requestRuntimeInstance, runtimeInstanceDirectory } from "../src/runtime/instance.js";
import type { RuntimeSummary } from "../src/runtime/presentation.js";
import { runRuntime, type RuntimeLaunch } from "../src/runtime/supervisor.js";
import { currentIdentityKey } from "../src/space.js";

test("an idle background Runtime hands its id to a newer CLI without the Space or this device seeing it go", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-handoff-"));
  const old = { ...process.env };
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const connections: Array<{ runtimeId: string | null; frames: string[] }> = [];
  server.on("connection", (socket, request) => {
    const connection = { runtimeId: new URL(request.url ?? "/", "http://x").searchParams.get("runtimeId"), frames: [] as string[] };
    connections.push(connection);
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      connection.frames.push(frame.type);
      if (frame.type === "runtime.hello") socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID(), features: ["handoff"] }));
      if (frame.type === "runtime.heartbeat" || frame.type === "runtime.handoff") socket.send(JSON.stringify({ type: frame.type }));
    });
  });
  const predecessor = new AbortController(), successor = new AbortController();
  const runs: Promise<unknown>[] = [];
  try {
    process.env.HOME = root;
    process.env.COHUB_EXECUTION_TOKEN = `header.${Buffer.from(JSON.stringify({ actorUserId: "fixture-owner" })).toString("base64url")}.signature`;
    process.env.COHUB_WS_URL = `ws://127.0.0.1:${address.port}`;
    process.env.COHUB_SANDBOXD_BIN = fileURLToPath(new URL("./fixtures/runtime-bridge.mjs", import.meta.url));
    await chmod(process.env.COHUB_SANDBOXD_BIN, 0o755);
    const cli = join(root, "newer-cli.mjs"), launched = join(root, "launched.json");
    await writeFile(cli, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(launched)}, JSON.stringify({ args: process.argv.slice(2), handoff: process.env.${RUNTIME_HANDOFF_ENV} }));\nsetTimeout(() => {}, 4000);\n`);
    const identity = currentIdentityKey(); assert(identity);
    const config: RuntimeLaunch = { spaceId: crypto.randomUUID(), root, identity, harnesses: ["pi"], capabilities: { harnesses: ["pi"], models: [] }, executables: {}, background: true };
    const directory = runtimeInstanceDirectory(identity, config.spaceId);
    const readyOf = (onReady: (status: RuntimeSummary) => void) => (status: RuntimeSummary) => { if (status.state === "ready" && !status.handoff) onReady(status); };

    const start = (launch: RuntimeLaunch, signal: AbortSignal) => {
      let ready!: (status: RuntimeSummary) => void;
      const serving = new Promise<RuntimeSummary>((resolve) => { ready = resolve; });
      const run = runRuntime(launch, readyOf(ready), signal);
      runs.push(run.catch(() => undefined));
      return { serving, run };
    };
    const older = start(config, predecessor.signal);
    const first = await older.serving;
    assert.deepEqual(await requestRuntimeUpdate(directory, { version: "999.0.0", node: process.execPath, entry: cli }).then((value) => value.started), true);
    assert.equal((await requestRuntimeInstance(directory))?.update, "999.0.0");

    const observed: Array<RuntimeSummary | null> = [];
    let watching = true;
    const watch = (async () => { while (watching) { observed.push(await requestRuntimeInstance(directory).catch(() => null)); await new Promise((resolve) => setTimeout(resolve, 10)); } })();
    const newer = start({ ...config, resume: { runtimeId: first.runtimeId, takeOver: true } }, successor.signal);
    assert.equal(await older.run, "999.0.0");
    const second = await newer.serving;
    watching = false; await watch;

    const launch = JSON.parse(await readFile(launched, "utf8"));
    assert.equal(launch.handoff, first.runtimeId);
    assert.deepEqual(launch.args, ["runtime", "up", root, "--space", config.spaceId, "--detach", "--yes", "--json", "--harness", "pi", "--no-display"]);
    assert.equal(second.runtimeId, first.runtimeId);
    assert.equal(second.handoff, undefined);
    assert.equal(observed.includes(null), false, "the instance always has an owner");
    assert(observed.every((status) => status?.runtimeId === first.runtimeId && (status.state === "ready" || status.handoff)), "this device never sees it disconnect");
    assert.deepEqual(connections.map((connection) => connection.runtimeId), [first.runtimeId, first.runtimeId]);
    assert(connections[0]?.frames.includes("runtime.handoff"));
    assert.equal((await requestRuntimeInstance(directory))?.runtimeId, first.runtimeId);
  } finally {
    predecessor.abort(); successor.abort();
    await Promise.all(runs);
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
