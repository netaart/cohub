import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { NativeIngest, type IngestHooks } from "../src/runtime/native/ingest.js";
import { nativeTurnId } from "../src/runtime/native/identity.js";
import { workbuddySessionPath } from "../src/runtime/native/workbuddy-transcript.js";
import { fakeNativeServer } from "./fixtures/native-server.js";

const at = "2026-01-01T00:00:00.000Z";
const spaceId = "00000000-0000-4000-8000-000000000001";
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const turnIdOf = (sessionId: string, key: string) => nativeTurnId(spaceId, "workbuddy", sessionId, key);
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for WorkBuddy ingest");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "cohub-workbuddy-ingest-")), project = join(root, "project"), home = join(root, "workbuddy");
  await mkdir(project, { recursive: true });
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  const instances: NativeIngest[] = [];
  const row = (sessionId: string, id: string, parentId: string | null, role: string, cwd = project) => ({ type: "message", id, parentId, role, sessionId, cwd, timestamp: at, status: "completed", content: [{ type: role === "assistant" ? "output_text" : "input_text", text: id }] });
  const turn = (sessionId: string, n: number, parentId: string | null, cwd = project) => line(row(sessionId, `u${n}`, parentId, "user", cwd)) + line(row(sessionId, `a${n}`, `u${n}`, "assistant", cwd));
  const quiet = async (path: string) => { const old = new Date(Date.now() - 60_000); await utimes(path, old, old); };
  const write = async (id: string, body: string, cwd = project) => {
    const path = workbuddySessionPath(home, cwd, id);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); await quiet(path); return path;
  };
  const ingest = (options: { enabledAt?: string; hooks?: IngestHooks; state?: string } = {}) => {
    const state = join(root, options.state ?? "state");
    const instance = new NativeIngest({ spaceId, cwd: project, harnesses: ["workbuddy"], enabledAt: options.enabledAt ?? new Date(0).toISOString(), root: state, archives: new RuntimeArchiveStore(join(state, "archives"), null), hooks: options.hooks });
    instances.push(instance); return instance;
  };
  const drain = async (instance: NativeIngest) => { await instance.scan(); await until(() => instance.status().live === 0); };
  return { root, project, home, row, turn, quiet, write, ingest, drain, cleanup: async () => {
    for (const instance of instances) await instance.close(AbortSignal.timeout(2_000));
    if (previous === undefined) delete process.env.WORKBUDDY_HOME; else process.env.WORKBUDDY_HOME = previous;
    await rm(root, { recursive: true, force: true });
  } };
}

test("WorkBuddy history requires import and replay sends no duplicate Turns", async () => {
  const w = await workspace();
  try {
    const server = fakeNativeServer(), id = randomUUID();
    const path = await w.write(id, w.turn(id, 1, null) + w.turn(id, 2, "a1"));
    const importer = w.ingest({ enabledAt: new Date().toISOString() });
    await importer.load(); importer.connect(server.transport); await w.drain(importer);
    assert.equal(server.turns.size, 0);
    assert.deepEqual((await importer.plan()).map((item) => item.nativeSessionId), [id]);
    await importer.startImport({}, 1);
    await until(() => importer.status().import.state === "done");
    const first = turnIdOf(id, "u1"), second = turnIdOf(id, "u2");
    assert.equal(server.turns.get(second)?.parentTurnId, first);
    assert.equal(server.turns.get(first)?.sessionId, server.turns.get(second)?.sessionId);
    assert.equal(server.turns.get(first)?.origin, "local_import");
    assert.equal(server.turns.get(second)?.settled, true);
    await importer.close();
    const batchCount = server.batches.length;
    // A new journal must still deduplicate from the server's stable IDs.
    const replay = w.ingest({ state: "fresh-state" });
    await replay.load(); replay.connect(server.transport); await w.drain(replay);
    assert.equal(server.batches.length, batchCount);
    await appendFile(path, w.turn(id, 3, "a2")); await w.quiet(path); await w.drain(replay);
    assert.equal(server.batches.length, batchCount + 1);
    assert.deepEqual(server.batches.at(-1)?.turns.map((turn) => turn.turnId), [turnIdOf(id, "u3")]);
    assert.equal(server.turns.get(turnIdOf(id, "u3"))?.parentTurnId, second);
  } finally { await w.cleanup(); }
});

test("WorkBuddy origin excludes restored history and keeps later desktop Turns in the same cloud Session", async () => {
  const w = await workspace();
  try {
    const server = fakeNativeServer(), id = randomUUID(), cloudTurnId = randomUUID(), sessionId = randomUUID();
    server.turns.set(cloudTurnId, { sessionId, settled: true, parentTurnId: null });
    const prefix = w.turn(id, 1, null), path = await w.write(id, prefix + w.turn(id, 2, "a1"));
    await writeFile(`${path}.cohub.json`, JSON.stringify({ nativeSessionId: id, cloudSessionId: sessionId, turnId: cloudTurnId, prefixBytes: Buffer.byteLength(prefix), prefixSha256: createHash("sha256").update(prefix).digest("hex") }));
    const first = w.ingest(); await first.load(); first.connect(server.transport); await w.drain(first);
    assert.equal(server.batches.length, 0, "neither restored history nor Cohub's own Turn may be uploaded again");
    assert.equal(first.transcriptFor(sessionId, "workbuddy", cloudTurnId)?.nativeSessionId, id);
    await first.close();
    await appendFile(path, w.turn(id, 3, "a2")); await w.quiet(path);
    const restarted = w.ingest(); await restarted.load(); restarted.connect(server.transport); await w.drain(restarted);
    const desktop = server.turns.get(turnIdOf(id, "u3"));
    assert.equal(desktop?.sessionId, sessionId);
    assert.equal(desktop?.parentTurnId, cloudTurnId);
    assert.equal(server.turns.size, 2);
    assert.deepEqual(server.batches.flatMap((batch) => batch.turns.map((turn) => turn.turnId)), [turnIdOf(id, "u3")]);
    // A later branch must query the older Cohub parent's identity, not use the latest desktop Turn.
    await appendFile(path, w.turn(id, 4, "a2")); await w.quiet(path); await w.drain(restarted);
    assert.equal(server.turns.get(turnIdOf(id, "u4"))?.parentTurnId, cloudTurnId);
  } finally { await w.cleanup(); }
});

test("WorkBuddy malformed records report an error and upload nothing; foreign projects stay excluded", async () => {
  const w = await workspace();
  try {
    const server = fakeNativeServer(), id = randomUUID(), other = randomUUID(), errors: unknown[] = [];
    await w.write(id, `${w.turn(id, 1, null)}{"type": broken}\n`);
    await w.write(other, w.turn(other, 1, null, `${w.project}-other`), `${w.project}-other`);
    const ingest = w.ingest({ hooks: { onError: (error) => errors.push(error) } });
    await ingest.load(); ingest.connect(server.transport); await w.drain(ingest);
    assert.equal(server.batches.length, 0);
    assert.equal(server.turns.size, 0);
    assert.match(String(errors[0]), /Invalid native JSON record/);
  } finally { await w.cleanup(); }
});

test("WorkBuddy history import reports unfinished tails while retaining completed Turns and source bytes", async () => {
  const w = await workspace();
  try {
    const server = fakeNativeServer(), id = randomUUID(), errors: unknown[] = [];
    const raw = w.turn(id, 1, null) + line(w.row(id, "u2", "a1", "user"));
    const path = await w.write(id, raw);
    const ingest = w.ingest({ enabledAt: new Date().toISOString(), hooks: { onError: (error) => errors.push(error) } });
    await ingest.load(); ingest.connect(server.transport); await w.drain(ingest);
    await ingest.startImport({}, 1); await until(() => ingest.status().import.state === "done");
    assert.equal(ingest.status().import.turns, 1);
    assert.equal(server.turns.size, 1);
    assert.equal(server.turns.get(turnIdOf(id, "u1"))?.settled, true);
    assert.equal(server.turns.has(turnIdOf(id, "u2")), false);
    assert.deepEqual(new Set(ingest.status().import.failed.map((failure) => failure.path)), new Set([path]));
    assert(ingest.status().import.failed.every((failure) => /unfinished Turn/.test(failure.message)));
    assert.equal(errors.length, 1);
    assert.equal(await readFile(path, "utf8"), raw);
    await w.drain(ingest);
    assert.equal(server.turns.size, 1, "a later live scan must not upload unchanged unfinished old history as running");
    await appendFile(path, line(w.row(id, "a2", "u2", "assistant"))); await w.quiet(path);
    await ingest.startImport({}, 1); await until(() => ingest.status().import.state === "done");
    assert.deepEqual(ingest.status().import.failed, []);
    assert.equal(server.turns.size, 2);
    assert.equal(server.batches.flatMap((batch) => batch.turns).filter((turn) => turn.turnId === turnIdOf(id, "u1")).length, 1);
    assert.equal(server.turns.get(turnIdOf(id, "u2"))?.parentTurnId, turnIdOf(id, "u1"));
  } finally { await w.cleanup(); }
});
