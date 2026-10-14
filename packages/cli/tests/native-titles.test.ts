import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { NativeIngest, type IngestHooks } from "../src/runtime/native/ingest.js";
import { fakeNativeServer } from "./fixtures/native-server.js";

const SPACE = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";
const NATIVE = "00000000-0000-4000-8000-000000000003";
const line = (title: string, id = NATIVE) => `${JSON.stringify({ id, thread_name: title, updated_at: "2026-01-01T00:00:00Z" })}\n`;
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for title sync");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function fixture(renameSession?: (id: string, title: string, signal: AbortSignal) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cohub-titles-"));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  await mkdir(process.env.CODEX_HOME, { recursive: true });
  const path = join(process.env.CODEX_HOME, "sessions", `rollout-2026-01-01T00-00-00-${NATIVE}.jsonl`);
  const index = join(process.env.CODEX_HOME, "session_index.jsonl");
  const calls: Array<{ id: string; title: string }> = [];
  const errors: unknown[] = [];
  const server = fakeNativeServer();
  const controller = new AbortController();
  const hooks: IngestHooks = {
    renameSession: async (id, title, signal) => { await renameSession?.(id, title, signal); calls.push({ id, title }); },
    onError: (error) => { errors.push(error); },
  };
  const make = () => new NativeIngest({ spaceId: SPACE, cwd: root, harnesses: ["codex"], enabledAt: new Date(0).toISOString(), root: join(root, "state"), archives: new RuntimeArchiveStore(join(root, "archives"), null), hooks });
  const ingest = make();
  ingest.adopt({ harness: "codex", nativeSessionId: NATIVE, cwd: root, path }, SESSION);
  return { root, path, index, calls, errors, server, controller, ingest, make,
    async cleanup() { controller.abort(); await ingest.close(AbortSignal.timeout(2_000)); if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; await rm(root, { recursive: true, force: true }); },
  };
}

test("Codex titles sync on connect and index-only edits, retaining the last confirmed name across restart", async () => {
  const w = await fixture();
  try {
    await writeFile(w.index, line("Old name") + line("Current name"));
    await w.ingest.watch(w.controller.signal);
    w.ingest.connect(w.server.transport);
    await until(() => w.calls.length === 1);
    assert.deepEqual(w.calls, [{ id: SESSION, title: "Current name" }]);
    await writeFile(`${w.index}.tmp`, line("Renamed locally"));
    await rename(`${w.index}.tmp`, w.index);
    await until(() => w.calls.length === 2);
    assert.deepEqual(w.calls[1], { id: SESSION, title: "Renamed locally" });
    await w.ingest.close(AbortSignal.timeout(2_000));
    const restarted = w.make();
    await restarted.load();
    restarted.connect(w.server.transport);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(w.calls.length, 2, "An unchanged local name must not overwrite a later web rename");
    restarted.adopt({ harness: "codex", nativeSessionId: NATIVE, cwd: w.root, path: w.path }, SPACE);
    await until(() => w.calls.length === 3);
    assert.deepEqual(w.calls[2], { id: SPACE, title: "Renamed locally" });
    await restarted.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("a failed title update is reported and retried without recording success", async () => {
  let attempts = 0;
  const w = await fixture(async () => { if (++attempts === 1) throw new Error("Rename unavailable"); });
  try {
    await writeFile(w.index, line("Retry this name"));
    w.ingest.connect(w.server.transport);
    await until(() => w.errors.length === 1);
    assert.match(String(w.errors[0]), /Rename unavailable/);
    assert.equal(w.calls.length, 0);
    await until(() => w.calls.length === 1);
    assert.equal(attempts, 2);
    assert.deepEqual(w.calls[0], { id: SESSION, title: "Retry this name" });
    await w.ingest.close(AbortSignal.timeout(2_000));
    const ledger = await readFile(join(w.root, "state", "native", "ledger.jsonl"), "utf8");
    assert.deepEqual(JSON.parse(ledger.trim().split("\n").at(-1)!).state.titleSync, { sessionId: SESSION, title: "Retry this name" });
  } finally { await w.cleanup(); }
});

test("bad title index records are exposed and only bound in-scope enabled Codex sessions are renamed", async () => {
  const w = await fixture();
  try {
    await writeFile(w.index, line("Bound name") + "broken json\n");
    w.ingest.connect(w.server.transport);
    await until(() => w.errors.length > 0);
    assert.equal(w.calls.length, 0, "A corrupt index must not partly apply");
    w.ingest.adopt({ harness: "codex", nativeSessionId: "foreign", cwd: "/outside", path: "/outside/rollout.jsonl" }, SPACE);
    const nested = join(w.root, "nested");
    w.ingest.adopt({ harness: "codex", nativeSessionId: "nested", cwd: nested, path: join(nested, "rollout.jsonl") }, SPACE);
    w.ingest.exclude([nested]);
    // Existing ledgers can contain internal threads; a title entry must never promote one to a user chat.
    const state = w.ingest.transcriptFor(SESSION, "codex", null)!;
    const ledger = join(w.root, "state", "native", "ledger.jsonl");
    await mkdir(join(w.root, "state", "native"), { recursive: true });
    await writeFile(ledger, ["internal", "spawned"].map((kind) => {
      const path = join(w.root, `${kind}.jsonl`);
      return JSON.stringify({ path, state: { ...state, path, nativeSessionId: kind, threadKind: kind } });
    }).join("\n") + "\n");
    await w.ingest.load();
    await writeFile(w.index, line("Bound name") + ["foreign", "unbound", "nested", "internal", "spawned"].map((id) => line(`${id} name`, id)).join(""));
    w.ingest.connect(w.server.transport);
    await until(() => w.calls.length === 1);
    assert.deepEqual(w.calls, [{ id: SESSION, title: "Bound name" }]);
    w.ingest.configure([], new Date(0).toISOString());
    await appendFile(w.index, line("Paused name"));
    w.ingest.connect(w.server.transport);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(w.calls.length, 1);
    w.ingest.configure(["codex"], new Date(0).toISOString());
    await until(() => w.calls.length === 2);
    assert.deepEqual(w.calls[1], { id: SESSION, title: "Paused name" });
  } finally { await w.cleanup(); }
});

test("an outstanding rename never holds up transcript ingest", async () => {
  let release!: () => void;
  let started = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const w = await fixture(async () => { started = true; await pending; });
  try {
    await writeFile(w.index, line("Slow rename"));
    w.ingest.connect(w.server.transport);
    await until(() => started);
    const timestamp = "2026-01-01T00:00:00Z";
    const records = [
      { type: "session_meta", payload: { id: NATIVE, cwd: w.root } },
      { type: "event_msg", payload: { type: "turn_started", turn_id: "t1" } },
      { type: "event_msg", payload: { type: "user_message", message: "Continue while renaming" } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: "t1", last_agent_message: "Finished" } },
    ];
    await mkdir(join(w.path, ".."), { recursive: true });
    await writeFile(w.path, records.map((record) => JSON.stringify({ timestamp, ...record })).join("\n") + "\n");
    w.ingest.touch(w.path);
    await until(() => w.server.turns.size === 1);
    assert.equal([...w.server.turns.values()][0]?.settled, true);
    assert.equal(w.calls.length, 0, "Content completed before the blocked title request returned");
  } finally { release(); await w.cleanup(); }
});

test("shutdown cancels an outstanding title request before flushing the ledger", async () => {
  let started = false;
  let requestSignal: AbortSignal | undefined;
  let release!: () => void;
  const w = await fixture(async (_id, _title, signal?: AbortSignal) => {
    started = true;
    requestSignal = signal;
    await new Promise<void>((resolve, reject) => {
      release = resolve;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  try {
    await writeFile(w.index, line("Pending rename"));
    w.ingest.connect(w.server.transport);
    await until(() => started);
    let closed = false;
    const closing = w.ingest.close(AbortSignal.timeout(100)).then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      assert.equal(requestSignal?.aborted, true, "Shutdown must cancel the in-flight request");
      assert.equal(closed, true, "An unresponsive title request must not hold the shutdown open");
      assert.equal(w.calls.length, 0, "An aborted rename is not persisted as successful");
      assert.equal(w.errors.length, 0, "Expected shutdown cancellation is not reported as a sync fault");
    } finally { release(); await closing; }
  } finally { await w.cleanup(); }
});

test("an unresponsive title request expires and retries without another file event", async (context) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => timeout(milliseconds === 10_000 ? 30 : milliseconds));
  let attempts = 0;
  const w = await fixture(async (_id, _title, signal) => {
    if (++attempts > 1) return;
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  try {
    await writeFile(w.index, line("Retry after deadline"));
    w.ingest.connect(w.server.transport);
    await until(() => w.calls.length === 1);
    assert.equal(attempts, 2);
    assert.equal(w.errors.length, 1);
    assert.match(String(w.errors[0]), /TimeoutError/);
    assert.deepEqual(w.calls, [{ id: SESSION, title: "Retry after deadline" }]);
  } finally { await w.cleanup(); }
});
