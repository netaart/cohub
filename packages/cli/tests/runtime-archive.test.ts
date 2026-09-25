import assert from "node:assert/strict";
import { testNativeRuntime } from "./fixtures/runtime-native.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { RUNTIME_ARCHIVE_SEGMENT_BYTES, type RuntimeTurnInput } from "@neta-art/cohub";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";

for (const harness of ["pi", "codex"] as const) test(`${harness}: append, equal-size rewrite and growing rewrite restore exact bytes`, async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-segments-"));
  const storage = await archiveStorageFixture();
  try {
    const store = new RuntimeArchiveStore(join(root, "state"), storage.transport);
    const state = { sessionId: randomUUID(), harness, nativeSessionId: randomUUID(), path: join(root, "native") };
    let parent: string | null = null;
    for (const [content, append] of [["first\n", false], ["first\n中文\n", true], ["other\n中文\n", false], ["rewritten entirely and longer\n", false]] as const) {
      await writeFile(state.path, content);
      const reference = await store.stage(state, randomUUID());
      await store.flush(new AbortController().signal);
      const index = storage.versions.get(reference.turnId);
      assert(index);
      assert.equal(index.parentTurnId, append ? parent : null);
      const target = join(root, `${reference.turnId}.restored`);
      await new RuntimeArchiveStore(join(root, "cold"), storage.transport).restore(reference, target);
      assert.deepEqual(await readFile(target), Buffer.from(content));
      parent = reference.turnId;
    }
    assert.equal((await readdir(join(root, "state", "pending"))).length, 0);
  } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
});

test("outbox retries after restart without another turn; corrupt downloads never replace a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-retry-"));
  const storage = await archiveStorageFixture();
  try {
    const archiveRoot = join(root, "state");
    const store = new RuntimeArchiveStore(archiveRoot, storage.transport);
    const state = { sessionId: randomUUID(), harness: "pi" as const, nativeSessionId: randomUUID(), path: join(root, "native") };
    await writeFile(state.path, '{"raw":"保留"}\n');
    const reference = await store.stage(state, randomUUID());
    storage.setOffline(true);
    await store.flush(new AbortController().signal);
    assert.equal((await readdir(join(archiveRoot, "pending"))).length, 1);
    storage.setOffline(false);
    const restarted = new RuntimeArchiveStore(archiveRoot, storage.transport);
    await restarted.flush(new AbortController().signal);
    const index = storage.versions.get(reference.turnId);
    assert(index?.segments[0]);
    storage.objects.set(index.segments[0].sha256, Buffer.from("corrupt"));
    const target = join(root, "target");
    await writeFile(target, "original");
    const cold = new RuntimeArchiveStore(join(root, "cold"), storage.transport);
    await assert.rejects(cold.restore(reference, target), /checksum mismatch/);
    assert.equal(await readFile(target, "utf8"), "original");
    assert.equal((await readdir(root)).some((name) => name.endsWith(".restoring")), false);
  } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
});

test("interrupted restore reuses verified segments and refreshes expired URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-download-retry-"));
  const storage = await archiveStorageFixture();
  try {
    const path = join(root, "native");
    const bytes = Buffer.concat([Buffer.alloc(RUNTIME_ARCHIVE_SEGMENT_BYTES, "a"), Buffer.from("tail")]);
    await writeFile(path, bytes);
    const store = new RuntimeArchiveStore(join(root, "state"), storage.transport);
    const reference = await store.stage({ sessionId: randomUUID(), harness: "pi", nativeSessionId: randomUUID(), path }, randomUUID());
    await store.flush(new AbortController().signal);
    const index = storage.versions.get(reference.turnId); assert(index?.segments[1]);
    const tailSha = index.segments[1].sha256;
    const fetchObject = storage.transport.fetchObject; assert(fetchObject);
    const calls = new Map<string, number>();
    const cold = new RuntimeArchiveStore(join(root, "cold"), { ...storage.transport, fetchObject: async (url, init) => {
      const sha = new URL(String(url)).pathname.slice(1);
      const count = (calls.get(sha) ?? 0) + 1; calls.set(sha, count);
      if (sha === tailSha && count === 1) throw new Error("download interrupted");
      if (sha === tailSha && count === 2) return new Response(null, { status: 403 });
      return fetchObject(url, init);
    } });
    const target = join(root, "restored");
    await assert.rejects(cold.restore(reference, target), /interrupted/);
    await assert.rejects(readFile(target), /ENOENT/);
    await cold.restore(reference, target);
    assert.deepEqual(await readFile(target), bytes);
    assert.equal(calls.get(index.segments[0]?.sha256 ?? ""), 1);
    assert.equal(calls.get(tailSha), 3);
  } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
});

const prepareInput = (turn: RuntimeTurnInput, root: string, signal?: AbortSignal) => ({ ...turn, cwd: root, signal, resumable: () => true });

for (const harness of ["pi", "codex"] as const) test(`${harness}: failed archive recovery rebuilds from Turn API and preserves originals`, async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-fallback-"));
  const runtime = await testNativeRuntime({ spaceId: randomUUID(), root, harnesses: [harness] });
  try {
    const { sessions } = runtime.native.executor;
    const sessionId = randomUUID(), priorTurnId = randomUUID(), turnId = randomUUID(), userMessageId = randomUUID();
    const turn: RuntimeTurnInput = { spaceId: randomUUID(), sessionId, turnId, userMessageId, harness, messages: [{ turnId, userMessageId, userId: "author", content: [{ type: "text", text: "continue" }] }], accessMode: "full_access",
      context: { complete: false, revision: "r", throughTurnId: priorTurnId, messages: [], archive: { sessionId, turnId: priorTurnId, harness } } };
    const rawFiles: string[] = [];
    runtime.archives.restore = async (_reference, target) => {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "corrupt native archive");
      rawFiles.push(target);
      throw new Error("checksum mismatch");
    };
    runtime.source.addTurn(sessionId, priorTurnId, { userContent: [{ type: "text", text: "historical DB fact" }] });
    const result = await sessions.prepare(prepareInput(turn, root));
    assert.equal(result.resume, "handoff");
    if (harness === "pi") assert.match(await readFile(result.session.path, "utf8"), /historical DB fact/);
    assert(rawFiles.length > 0);
    // An archive whose header does not match is not imported either; the Session is rebuilt.
    runtime.archives.restore = async (_reference, target) => {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "invalid native header");
      return { version: 1, sessionId, turnId: priorTurnId, harness, nativeFormat: harness === "pi" ? "pi.jsonl" : "codex.rollout",
        nativeSessionId: randomUUID(), parentTurnId: null, segments: [], sha256: "a".repeat(64), sizeBytes: 21 };
    };
    const renamed = randomUUID();
    assert.equal((await sessions.prepare(prepareInput({ ...turn, sessionId: renamed, context: { ...turn.context, archive: { sessionId: renamed, turnId: priorTurnId, harness } } }, root))).resume, "handoff");
    // A cancelled prepare propagates.
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const otherSession = randomUUID();
    await assert.rejects(sessions.prepare(prepareInput({ ...turn, sessionId: otherSession, context: { ...turn.context, archive: { sessionId: otherSession, turnId: priorTurnId, harness } } }, root, controller.signal)), /cancelled/);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("Pi projection retains a durable compaction Turn as a native boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-"));
  const runtime = await testNativeRuntime({ spaceId: randomUUID(), root, harnesses: ["pi"] });
  try {
    const turnId = randomUUID(), userMessageId = randomUUID();
    const sessionId = randomUUID(), compactTurnId = randomUUID();
    runtime.source.addTurn(sessionId, compactTurnId, { intent: "compact", assistantContent: [{ type: "system_note", note_type: "compacted", text: "remember this" }] });
    const { session } = await runtime.native.executor.sessions.prepare(prepareInput({ spaceId: randomUUID(), sessionId, turnId, userMessageId, harness: "pi", messages: [{ turnId, userMessageId, userId: "author", content: [{ type: "text", text: "continue" }] }], accessMode: "full_access",
      context: { revision: "r", throughTurnId: compactTurnId, messages: [{ id: "summary", turnId: compactTurnId, role: "system", content: [{ type: "system_note", note_type: "compacted", text: "remember this" }] }] } }, root));
    const rows = (await readFile(session.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows[1].type, "compaction"); assert.equal(rows[1].summary, "remember this");
    assert.equal(rows.filter((row) => row.type === "message").length, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
