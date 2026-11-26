import { nativeFixtureHome } from "./fixtures/native-home.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeSpaceBindingsPath } from "../src/runtime/space-binding.js";
import { testNativeRuntime } from "./fixtures/runtime-native.js";
import { fakeNativeServer } from "./fixtures/native-server.js";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const codexTurn = (key: string) => [
  line({ type: "event_msg", payload: { type: "turn_started", turn_id: key } }),
  line({ type: "event_msg", payload: { type: "user_message", message: `q ${key}` } }),
  line({ type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } }),
].join("");

async function until(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a subdirectory bound to another Space while the Runtime runs leaves its scope, and comes back when rebound", async () => {
  const home = await realpath(nativeFixtureHome);
  const root = join(home, "project");
  const child = join(root, "child");
  const spaceId = randomUUID();
  await mkdir(child, { recursive: true });
  process.env.CODEX_HOME = join(home, "codex-home");
  const rollout = async (cwd: string, key: string) => {
    const id = randomUUID();
    const path = join(home, "codex-home", "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, line({ type: "session_meta", payload: { id, cwd } }) + codexTurn(key));
    return path;
  };
  const bind = async (bindings: Array<{ root: string; spaceId: string }>) => {
    const path = runtimeSpaceBindingsPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, bindings: bindings.map((binding) => ({ ...binding, key: "test" })) }));
    await rename(`${path}.tmp`, path);
  };
  await bind([{ root, spaceId }]);
  const runtime = await testNativeRuntime({
    spaceId, root, harnesses: ["codex"],
    config: { version: 2, identity: "test", spaceId, root, harnesses: ["codex"], enabledAt: "2026-01-01T00:00:00.000Z", codexShared: false },
  });
  const server = fakeNativeServer();
  const synced = (key: string) => server.batches.some((batch) => batch.turns.some((turn) => JSON.stringify(turn.userContent).includes(`q ${key}`)));
  try {
    runtime.native.ingest.connect(server.transport);
    const before = await rollout(child, "before");
    await until(() => synced("before"));

    await bind([{ root, spaceId }, { root: child, spaceId: randomUUID() }]);
    await until(() => !runtime.native.ingest.owns(child));
    const outside = await rollout(child, "outside");
    await appendFile(before, codexTurn("later"));
    await rollout(root, "parent");
    await until(() => synced("parent"));
    assert(!synced("outside") && !synced("later"), "the child's transcripts belong to its own Space");

    await bind([{ root, spaceId }]);
    await until(() => runtime.native.ingest.owns(child));
    await appendFile(outside, codexTurn("again"));
    await until(() => synced("again"));
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});
