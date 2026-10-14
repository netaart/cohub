import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeIngest } from "../src/runtime/native/ingest.js";
import { readNativeTranscript } from "../src/runtime/native/transcript.js";
const here = tmpdir();
const at = "2026-10-12T00:00:00.000Z";
const row = (type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ timestamp: at, type, payload, ...extra });
const start = (key: string) => row("event_msg", { type: "task_started", turn_id: key });
const end = (key: string) => row("event_msg", { type: "task_complete", turn_id: key, last_agent_message: "done" });
const typed = (text: string, id: string) => row("event_msg", { type: "item_completed", item: { type: "UserMessage", client_id: id, content: [{ type: "text", text }] } });
const legacy = (text: string, id?: string) => row("event_msg", { type: "user_message", message: text, ...(id ? { client_id: id } : {}) });
const response = (text: string) => row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
const header = row("session_meta", { id: "11111111-1111-4111-8111-111111111111", cwd: here });
async function parse(rows: ReturnType<typeof row>[]) {
  const dir = await mkdtemp(join(tmpdir(), "cohub-prompt-identity-"));
  try {
    const path = join(dir, "record.jsonl");
    await writeFile(path, [header, ...rows].map(x => JSON.stringify(x)).join("\n") + "\n");
    return await readNativeTranscript(path, "codex");
  } finally { await rm(dir, { recursive: true }); }
}
const expected = [{ type: "text", text: "original request" }];
for (const [name, initial, later] of [
  ["typed steering", typed("original request", "initial-id"), [typed("steer request", "steer-id")]],
  ["question reply", typed("original request", "initial-id"), [typed("<send_user_message_question_reply>answer</send_user_message_question_reply>", "reply-id")]],
  ["response duplicates", typed("original request", "initial-id"), [response("steer request"), typed("steer request", "steer-id")]],
  ["new event format", legacy("original request", "initial-id"), [legacy("steer request", "steer-id"), response("steer request")]],
  ["mixed event formats", legacy("original request", "initial-id"), [typed("steer request", "steer-id")]],
] as Array<[string, ReturnType<typeof row>, ReturnType<typeof row>[]]>) {
  test(`${name}: original prompt and source identity remain stable until completion`, async () => {
    const before = (await parse([start("k1"), initial])).turns[0];
    const after = (await parse([start("k1"), initial, ...later, end("k1")])).turns[0];
    assert.deepEqual(before.userContent, expected);
    assert.deepEqual(after.userContent, expected);
    assert.equal(before.cloudTurnId, "initial-id");
    assert.equal(after.cloudTurnId, "initial-id");
    assert.equal(after.result.status, "completed");
  });
}
test("a new task resets the prompt anchor; environment context stays out of typed prompts", async () => {
  const x = await parse([start("k1"), response("<environment_context/>"), typed("original request", "initial-id"), response("steer"), typed("steer", "steer-id"), end("k1"), start("k2"), response("<environment_context/>"), typed("next request", "next-id"), end("k2")]);
  assert.equal(x.turns.length, 2);
  assert.deepEqual(x.turns[0].userContent, expected);
  assert.deepEqual(x.turns[1].userContent, [{ type: "text", text: "next request" }]);
  assert.equal(x.turns[1].cloudTurnId, "next-id");
  assert.equal(x.turns[1].parentKey, "k1");
});
test("production ingest completes an already registered turn and appends the next, without changing its identity", async () => {
  const ingest: any = new NativeIngest({ spaceId: "55555555-5555-4555-8555-555555555555", cwd: here, root: here, harnesses: ["codex"], enabledAt: at, archives: { stage: async () => null } as any });
  ingest.stopped = true;
  const records = new Map();
  const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
  ingest.transport = {
    status: async () => ({ status: "running" }),
    known: async ids => ids.flatMap(id => records.has(id) ? [{ turnId: id, sessionId: "original-session", settled: records.get(id).settled }] : []),
    ingest: async ({ input }) => ({ turns: input.turns.map(t => {
      const identity = { turnId: t.turnId, parentTurnId: t.parentTurnId, harness: input.harness, nativeSessionId: input.nativeSessionId, userContent: t.userContent, startedAt: t.startedAt };
      const existing = records.get(t.turnId);
      if (existing) assert.equal(digest(identity), existing.digest, "Native Turn identity mismatch");
      records.set(t.turnId, { digest: digest(identity), settled: Boolean(t.result), prompt: t.userContent });
      return { turnId: t.turnId, sessionId: "original-session", settled: Boolean(t.result) };
    }) }),
  };
  const a = await parse([start("k1"), typed("original request", "initial-id")]);
  const state = ingest.blank("/unused", a.nativeSessionId, here, "codex", "user", { size: -1, mtimeMs: 0, ino: 0 });
  await ingest.apply(state, a.turns, "live", Date.parse(at));
  assert.equal(records.size, 1);
  assert.equal([...records.values()][0].settled, false);
  const b = await parse([start("k1"), typed("original request", "initial-id"), response("steer"), typed("steer", "steer-id"), end("k1"), start("k2"), typed("next request", "next-id"), end("k2")]);
  await ingest.apply(state, b.turns, "live", Date.parse(at));
  assert.equal(records.size, 2);
  assert.deepEqual([...records.values()].map(x => x.prompt), [expected, [{ type: "text", text: "next request" }]]);
  assert([...records.values()].every(x => x.settled));
  assert.equal(state.runningTurnId, null);
  assert.equal(state.throughTurnKey, "k2");
});
test("corrupted turn boundaries still fail explicitly", async () => {
  await assert.rejects(parse([start("k1"), typed("original request", "initial-id"), end("wrong-turn")]), /boundary mismatch/);
});
