import assert from "node:assert/strict";
import { TestRuntimeSessionStore } from "./fixtures/runtime-projection-source.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
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

for (const failure of ["changed", "missing", "malformed"] as const) test(`irrecoverable ${failure} capture is quarantined once without changing native files`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "archive-quarantine-"));
  const logs = t.mock.method(console, "error", () => {});
  try {
    const store = new TestRuntimeSessionStore(randomUUID(), root);
    const turnId = randomUUID(), userMessageId = randomUUID();
    const { state } = await store.prepare({ spaceId: randomUUID(), sessionId: randomUUID(), turnId, userMessageId, harness: "pi",
      messages: [{ turnId, userMessageId, userId: "author", content: [{ type: "text", text: "request" }] }], accessMode: "full_access",
      context: { revision: "r", throughTurnId: null, messages: [] } }, root);
    await store.started(state, turnId);
    store.archives.stage = async () => { throw new Error("temporary capture failure"); };
    await assert.rejects(store.archive(state, turnId));
    await store.recordResult(state, randomUUID(), [{ type: "turn.end", message: { ordinal: 0, content: [{ type: "text", text: "done" }] }, resume: "new", archive: null }]);
    const receiptPath = join(store.archives.root, "captures", `${turnId}.json`);
    if (failure === "changed") await writeFile(state.path, "externally edited; do not overwrite");
    if (failure === "missing") await rm(state.path);
    if (failure === "malformed") await writeFile(receiptPath, '{"incomplete":');
    const receipt = await readFile(receiptPath, "utf8");
    const native = failure === "missing" ? null : await readFile(state.path, "utf8");
    assert.equal(await store.archives.pendingCount(), 1);
    await Promise.all([store.flushArchives(new AbortController().signal), store.flushArchives(new AbortController().signal)]);
    assert.equal(await store.archives.pendingCount(), 0); assert.equal(await store.archives.failedCaptureCount(), 1);
    const directory = join(store.archives.root, "failed", "captures");
    const [name] = await readdir(directory); assert(name);
    const preserved = JSON.parse(await readFile(join(directory, name), "utf8"));
    assert.equal(preserved.receipt, receipt); assert(preserved.reason); assert(preserved.failedAt);
    const logged = logs.mock.callCount();
    await store.flushArchives(new AbortController().signal);
    assert.equal(logs.mock.callCount(), logged, "quarantined receipts are not checked or logged again");
    if (native !== null) assert.equal(await readFile(state.path, "utf8"), native);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed capture is retried after restart without a new model turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-capture-retry-"));
  const storage = await archiveStorageFixture();
  try {
    const spaceId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID(), userMessageId = randomUUID();
    const store = new TestRuntimeSessionStore(spaceId, root, storage.transport);
    const { state } = await store.prepare({ spaceId, sessionId, turnId, userMessageId, harness: "pi", messages: [{ turnId, userMessageId, userId: "author", content: [{ type: "text", text: "request" }] }], accessMode: "full_access",
      context: { revision: "r", throughTurnId: null, messages: [] } }, root);
    await store.started(state, turnId);
    store.archives.stage = async () => { throw new Error("injected capture failure"); };
    await assert.rejects(store.archive(state, turnId), /capture failure/);
    await store.recordResult(state, randomUUID(), [{ type: "turn.end", message: { ordinal: 0, content: [{ type: "text", text: "done" }] }, resume: "new", archive: null }]);
    await store.acknowledge(state, turnId, "completed");
    const restarted = new TestRuntimeSessionStore(spaceId, root, storage.transport);
    assert.equal(await restarted.archives.pendingCount(), 1);
    const stage = restarted.archives.stage.bind(restarted.archives);
    restarted.archives.stage = async () => { throw Object.assign(new Error("temporary IO failure"), { code: "EIO" }); };
    await restarted.flushArchives(new AbortController().signal);
    assert.equal(await restarted.archives.pendingCount(), 1);
    assert.equal(await restarted.archives.failedCaptureCount(), 0, "transient IO failures remain retryable");
    restarted.archives.stage = stage;
    await restarted.flushArchives(new AbortController().signal);
    assert(storage.versions.has(turnId));
    assert.equal(await restarted.archives.pendingCount(), 0);
  } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
});

for (const harness of ["pi", "codex"] as const) test(`${harness}: failed archive recovery rebuilds from Turn API and preserves originals`, async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-fallback-"));
  try {
    const store = new TestRuntimeSessionStore(randomUUID(), root);
    const sessionId = randomUUID(), priorTurnId = randomUUID(), turnId = randomUUID(), userMessageId = randomUUID();
    const turn: RuntimeTurnInput = { spaceId: randomUUID(), sessionId, turnId, userMessageId, harness, messages: [{ turnId, userMessageId, userId: "author", content: [{ type: "text", text: "continue" }] }], accessMode: "full_access",
      context: { complete: false, revision: "r", throughTurnId: priorTurnId, messages: [], archive: { sessionId, turnId: priorTurnId, harness } } };
    const rawFiles: string[] = [];
    store.archives.restore = async (_reference, target) => {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "corrupt native archive");
      rawFiles.push(target);
      throw new Error("checksum mismatch");
    };
    store.projectionSource.addTurn(sessionId, priorTurnId, { userContent: [{ type: "text", text: "historical DB fact" }] });
    const result = await store.prepare(turn, root);
    assert.equal(result.resume, "handoff");
    if (harness === "pi") assert.match(await readFile(result.state.path, "utf8"), /historical DB fact/);
    for (const raw of rawFiles) assert.equal(await readFile(raw, "utf8"), "corrupt native archive");
    // A transient failure is not remembered: the next resume retries the restore.
    let transientRetries = 0;
    store.archives.restore = async (_reference, target) => {
      transientRetries += 1;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "invalid native header");
      return { version: 1, sessionId, turnId: priorTurnId, harness, nativeFormat: harness === "pi" ? "pi.jsonl" : "codex.rollout",
        nativeSessionId: randomUUID(), parentTurnId: null, segments: [], sha256: "a".repeat(64), sizeBytes: 21 };
    };
    assert.equal((await store.prepare(turn, root)).resume, "handoff", "an invalid native header also rebuilds from Turn API");
    assert.ok(transientRetries > 0, "the transient failure stays retryable");
    // A cancelled prepare still propagates, and cancellation must not poison the retry verdict.
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(store.prepare(turn, root, controller.signal), /cancelled/);
    // Structurally unrestorable archives (a Codex leaf without its ancestor) are remembered once.
    if (harness === "codex") {
      store.archives.restore = async (_reference, target) => {
        await mkdir(dirname(target), { recursive: true });
        const nativeSessionId = randomUUID();
        await writeFile(target, `${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, cwd: root, history_mode: "paginated", history_base: { thread_id: randomUUID(), end_ordinal_exclusive: 2, end_byte_offset: 40 } } })}\n`);
        return { version: 1, sessionId, turnId: priorTurnId, harness, nativeFormat: "codex.rollout",
          nativeSessionId, parentTurnId: null, segments: [], sha256: "b".repeat(64), sizeBytes: 60 };
      };
      assert.equal((await store.prepare(turn, root)).resume, "handoff", "an unrestorable archive rebuilds from Turn API");
      const restoreCalls: string[] = [];
      store.archives.restore = async (reference, _target) => { restoreCalls.push(reference.turnId); throw new Error("unreachable"); };
      assert.equal((await store.prepare(turn, root)).resume, "handoff", "the remembered verdict skips the known-unrestorable archive");
      assert.deepEqual(restoreCalls, [], "no second download for a structural failure");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi projection retains a durable compaction Turn as a native boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-"));
  try {
    const store = new TestRuntimeSessionStore(randomUUID(), root);
    const turnId = randomUUID(), userMessageId = randomUUID();
    const sessionId = randomUUID(), compactTurnId = randomUUID();
    store.projectionSource.addTurn(sessionId, compactTurnId, { intent: "compact", assistantContent: [{ type: "system_note", note_type: "compacted", text: "remember this" }] });
    const { state } = await store.prepare({ spaceId: randomUUID(), sessionId, turnId, userMessageId, harness: "pi", messages: [{ turnId, userMessageId, userId: "author", content: [{ type: "text", text: "continue" }] }], accessMode: "full_access",
      context: { revision: "r", throughTurnId: compactTurnId, messages: [{ id: "summary", turnId: compactTurnId, role: "system", content: [{ type: "system_note", note_type: "compacted", text: "remember this" }] }] } }, root);
    const rows = (await readFile(state.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows[1].type, "compaction"); assert.equal(rows[1].summary, "remember this");
    assert.equal(rows.filter((row) => row.type === "message").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
