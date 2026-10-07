import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../runtime/local-session-manager.js";
import { syncCloudContext } from "../runtime/cloud-context.js";
import { createRuntimeStream } from "../stream/runtime-stream.js";
import type { RuntimeContext, RuntimeContextMessage } from "@cohub/protocol";
import type { SessionStreamEvent } from "@cohub/protocol/realtime";

const history: RuntimeContext = {
  revision: "first", throughTurnId: "turn-1", messages: [
    { id: "user-1", turnId: "turn-1", role: "user", content: [{ type: "text", text: "historical request" }] },
    { id: "assistant-1", turnId: "turn-1", role: "assistant", content: [{ type: "text", text: "historical result" }] },
  ],
};

const compactionMessage = (input: { id: string; turnId: string; summary: string; compactionId: string }): RuntimeContextMessage => ({
  id: input.id,
  turnId: input.turnId,
  role: "system",
  content: [{ type: "system_note", note_type: "compacted", text: input.summary }],
  meta: { compaction: { compactionId: input.compactionId, compactedAt: "2026-01-01T00:00:00.000Z", tokensBefore: 128 } },
});

test("a non-projectable retained row never blocks or half-writes a compaction boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-cloud-anchor-"));
  try {
    const manager = SessionManager.create(root, root);
    manager.newSession({ id: "test" });
    const context: RuntimeContext = {
      revision: "r1", throughTurnId: "turn-2", messages: [
        compactionMessage({ id: "compact-1", turnId: "turn-2", summary: "earlier work summarized", compactionId: "c1" }),
        { id: "note", turnId: "turn-2", role: "user", content: [{ type: "system_note", note_type: "info", text: "not model input" }] },
        { id: "user-3", turnId: "turn-2", role: "user", content: [{ type: "text", text: "after the note" }] },
      ],
    };
    assert.equal(syncCloudContext(manager, context), true);
    const messages = manager.buildSessionContext().messages;
    assert.deepEqual(messages.map((message) => message.role), ["compactionSummary", "user"]);
    const retained = (messages[1] as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content?.[0];
    assert(retained && retained.type === "text");
    assert.equal(retained.text, "after the note");
    assert.equal(JSON.stringify(manager.getEntries()).includes("historical"), false, "nothing is written as invented text");
    // The dropped row must not make the boundary unstable on later syncs either.
    const next: RuntimeContext = { ...context, revision: "r2", throughTurnId: "turn-3",
      messages: [...context.messages, { id: "user-4", turnId: "turn-3", role: "user", content: [{ type: "text", text: "later" }] }] };
    assert.equal(syncCloudContext(manager, next), true);
    assert.equal(syncCloudContext(manager, next), false);
    assert.deepEqual(manager.buildSessionContext().messages.map((message) => message.role), ["compactionSummary", "user", "user"]);
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cloud materialization restores history and appends a local Harness tail exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-cloud-restore-"));
  try {
    const manager = SessionManager.create(root, root);
    manager.newSession({ id: "test" });
    assert.equal(syncCloudContext(manager, history), true);
    assert.equal(manager.buildSessionContext().messages.length, 2);
    assert.equal(syncCloudContext(manager, history), false);
    const next: RuntimeContext = { revision: "second", throughTurnId: "turn-2", messages: [...history.messages, { id: "codex-message", turnId: "turn-2", role: "assistant", content: [{ type: "text", text: "local result" }] }] };
    assert.equal(syncCloudContext(manager, next), true);
    assert.equal(manager.buildSessionContext().messages.length, 3);
    assert.equal(syncCloudContext(manager, next), false);
    const data = manager.serializeSnapshot();
    assert(data.includes("local result"));
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Durable compactions become native boundaries, never projected messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-cloud-compaction-"));
  try {
    const manager = SessionManager.create(root, root);
    manager.newSession({ id: "test" });
    const context: RuntimeContext = {
      revision: "r1", throughTurnId: "turn-2", messages: [
        compactionMessage({ id: "compact-1", turnId: "turn-2", summary: "earlier work summarized", compactionId: "c1" }),
        { id: "user-2", turnId: "turn-2", role: "user", content: [{ type: "text", text: "after compaction" }] },
      ],
    };
    assert.equal(syncCloudContext(manager, context), true);
    const messages = manager.buildSessionContext().messages;
    assert.deepEqual(messages.map((message) => message.role), ["compactionSummary", "user"]);
    assert.equal((messages[0] as { summary?: string }).summary, "earlier work summarized");
    assert.equal(JSON.stringify(messages).includes("system_note"), false);
    assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);

    // A later turn extends the compacted history without anchoring a second boundary.
    const next: RuntimeContext = {
      revision: "r2", throughTurnId: "turn-3",
      messages: [...context.messages, { id: "user-3", turnId: "turn-3", role: "user", content: [{ type: "text", text: "third" }] }],
    };
    assert.equal(syncCloudContext(manager, next), true);
    assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
    assert.deepEqual(manager.buildSessionContext().messages.map((message) => message.role), ["compactionSummary", "user", "user"]);
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("A compaction that retains nothing renders as a summary-only context", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-cloud-compaction-empty-"));
  try {
    const manager = SessionManager.create(root, root);
    manager.newSession({ id: "test" });
    const context: RuntimeContext = {
      revision: "r1", throughTurnId: "turn-1",
      messages: [compactionMessage({ id: "compact-1", turnId: "turn-1", summary: "everything summarized", compactionId: "c1" })],
    };
    assert.equal(syncCloudContext(manager, context), true);
    const messages = manager.buildSessionContext().messages;
    assert.deepEqual(messages.map((message) => message.role), ["compactionSummary"]);
    assert.equal(JSON.stringify(messages).includes("system_note"), false);
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Runtime stream failures recover with increasing keyframe sequences and never reject final flush", async () => {
  const events: SessionStreamEvent[] = [];
  const stream = createRuntimeStream({ spaceId: "s", sessionId: "session", turnId: "turn", userMessageId: "u" }, async (event) => {
    events.push(event);
    if (events.length === 1 || events.length === 3) throw new Error("publish failed after accepting the frame");
  });
  stream.apply({ type: "message.start", ordinal: 0 });
  stream.apply({ type: "text.delta", ordinal: 0, index: 0, kind: "text", delta: "first" });
  await stream.flush();
  stream.apply({ type: "text.delta", ordinal: 0, index: 0, kind: "text", delta: " second" });
  await stream.flush();
  assert.equal(events.length, 2);
  assert.equal(events[1]?.seq, 2); assert.equal(events[1]?.baseSeq, 0);
  assert.equal(events[1]?.snapshotContent?.[0]?.type === "text" && events[1].snapshotContent[0].text, "first second");
  stream.apply({ type: "text.delta", ordinal: 0, index: 0, kind: "text", delta: " final" });
  await stream.commit(0);
  stream.dispose();
});

test("Runtime stream batches sparse and interleaved deltas with cloud-compatible message identities", async () => {
  const published: SessionStreamEvent[] = [];
  const stream = createRuntimeStream({ spaceId: "s", sessionId: "session", turnId: "turn", userMessageId: "user" }, async (event) => { published.push(event); });
  stream.apply({ type: "message.start", ordinal: 0 });
  stream.apply({ type: "text.delta", ordinal: 0, index: 1, kind: "text", delta: "one" });
  stream.apply({ type: "text.delta", ordinal: 0, index: 1, kind: "text", delta: " two" });
  await stream.flush();
  stream.apply({ type: "message.start", ordinal: 1 });
  stream.apply({ type: "text.delta", ordinal: 1, index: 0, kind: "text", delta: "next" });
  stream.apply({ type: "text.delta", ordinal: 0, index: 1, kind: "text", delta: " three" });
  await stream.flush();
  stream.dispose();
  assert.equal(published[0]?.messageId, "turn:turn:assistant:0");
  assert.deepEqual(published[0]?.content, [{ type: "text", text: "one two", _meta: { streamIndex: 1 } }]);
  assert.equal(published[1]?.seq, 2);
  assert.equal(published[1]?.baseSeq, 1);
  assert.equal(published[2]?.messageOrdinal, 1);
  assert.equal(published[2]?.baseSeq, 0);
});
