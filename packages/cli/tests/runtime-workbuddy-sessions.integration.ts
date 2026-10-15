import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { NativeSessions } from "../src/runtime/native/sessions.js";
import type { NativeIngest, TranscriptState } from "../src/runtime/native/ingest.js";
import type { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { runtimeProjectionSource } from "./fixtures/runtime-projection-source.js";
import { workbuddySessionPath } from "../src/runtime/native/workbuddy-transcript.js";
import { workbuddySidecarPath } from "../src/runtime/native/workbuddy-ownership.js";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-sessions-"));
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = join(root, "workbuddy");
  const spaceId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID(), priorTurnId = randomUUID();
  const source = runtimeProjectionSource();
  const adopted: unknown[][] = [];
  let existing: TranscriptState | null = null;
  const archives = { restore: async (_reference: unknown, _path: string) => { throw new Error("unexpected restore"); } };
  const ingest = { transcriptFor: () => existing, adopt: (...args: unknown[]) => adopted.push(args) };
  const sessions = new NativeSessions({ root, spaceId, projectionSource: source, archives: archives as unknown as RuntimeArchiveStore, ingest: ingest as unknown as NativeIngest });
  const input = { sessionId, turnId, harness: "workbuddy" as const, cwd: root, context: { revision: "r", throughTurnId: null as string | null, messages: [] }, resumable: () => true };
  return { root, home: process.env.WORKBUDDY_HOME, spaceId, sessionId, turnId, priorTurnId, source, sessions, archives, adopted, input,
    setExisting(value: TranscriptState | null) { existing = value; },
    async close() { if (previous === undefined) delete process.env.WORKBUDDY_HOME; else process.env.WORKBUDDY_HOME = previous; await rm(root, { recursive: true, force: true }); },
  };
}

async function nativeSource(w: Awaited<ReturnType<typeof fixture>>) {
  const nativeSessionId = randomUUID(), path = workbuddySessionPath(w.home, w.root, nativeSessionId), id = randomUUID();
  const original = `${JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "history" }], id, parentId: null, sessionId: nativeSessionId, cwd: w.root, timestamp: "2026-10-12T00:00:00.000Z", cohub: { schema: "cohub.projection.v2", sessionId: w.sessionId, turnId: w.priorTurnId } })}\n`;
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, original);
  const state = { harness: "workbuddy", nativeSessionId, path, cwd: w.root, sessionId: w.sessionId, headTurnId: w.priorTurnId } as TranscriptState;
  w.setExisting(state); w.input.context.throughTurnId = w.priorTurnId;
  return { nativeSessionId, path, original };
}

test("WorkBuddy continuation copies history and never modifies the user's file", async () => {
  const w = await fixture();
  try {
    const original = await nativeSource(w), result = await w.sessions.prepare(w.input);
    assert.equal(result.resume, "native");
    assert.notEqual(result.session.path, original.path);
    assert.notEqual(result.session.nativeSessionId, original.nativeSessionId);
    assert.equal(await readFile(original.path, "utf8"), original.original);
    const bytes = await readFile(result.session.path), row = JSON.parse(bytes.toString());
    assert.equal(row.sessionId, result.session.nativeSessionId);
    assert.deepEqual(row.content, [{ type: "input_text", text: "history" }]);
    const origin = JSON.parse(await readFile(`${result.session.path}.cohub.json`, "utf8"));
    assert.equal(origin.prefixSha256, sha256(bytes)); assert.equal(origin.prefixBytes, bytes.length);
  } finally { await w.close(); }
});

test("WorkBuddy rejects history appended after the cached cloud head even when the source is now idle", async () => {
  const w = await fixture();
  try {
    const original = await nativeSource(w), first = JSON.parse(original.original);
    const unseen = { ...first, id: randomUUID(), parentId: first.id, content: [{ type: "input_text", text: "not yet synchronized" }] };
    delete unseen.cohub;
    await appendFile(original.path, `${JSON.stringify(unseen)}\n`);
    const bytes = await readFile(original.path);
    await assert.rejects(w.sessions.prepare(w.input), /WorkBuddy source history does not match the Session head/);
    assert.deepEqual(await readFile(original.path), bytes, "rejecting stale history never rewrites the user's transcript");
    assert.deepEqual(w.adopted, [], "unseen history must not become a hidden execution prefix");
  } finally { await w.close(); }
});

test("WorkBuddy refuses an occupied native session without touching its file", async () => {
  const w = await fixture();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const original = await nativeSource(w), path = await workbuddySidecarPath(w.home);
    await mkdir(dirname(path), { recursive: true });
    const activeServer = createServer((socket) => socket.once("data", (bytes) => {
      const request = JSON.parse(bytes.toString());
      assert.equal(request.method, "session.list");
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [{ sessionId: original.nativeSessionId }] })}\n`);
    }));
    server = activeServer;
    await new Promise<void>((resolve, reject) => { activeServer.once("error", reject); activeServer.listen(path, resolve); });
    await assert.rejects(w.sessions.prepare(w.input), /Close (?:the )?WorkBuddy session before continuing/i);
    assert.equal(await readFile(original.path, "utf8"), original.original);
    assert.deepEqual(w.adopted, []);
  } finally { const activeServer = server; if (activeServer) await new Promise<void>((resolve) => activeServer.close(() => resolve())); await w.close(); }
});
