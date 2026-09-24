import assert from "node:assert/strict";
import { testNativeRuntime } from "./fixtures/runtime-native.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import { executeTurn } from "../src/runtime/native/execution.js";

function input(harness: "pi" | "codex"): RuntimeTurnInput {
  const messages = ["Alice", "Bob", "Charlie"].map((userId, index) => ({
    userId, turnId: randomUUID(), userMessageId: randomUUID(), content: [{ type: "text" as const, text: `ordered-input-${index}` }],
  }));
  const owner = messages.at(-1); assert(owner);
  return { spaceId: randomUUID(), sessionId: randomUUID(), turnId: owner.turnId, userMessageId: owner.userMessageId, harness, messages,
    context: { complete: true, revision: "initial", throughTurnId: null, messages: [] }, accessMode: "full_access" };
}

test("batch inputs reach the harness verbatim without markers, identities or extra text", () => {
  const turn = input("pi");
  const image = { type: "image" as const, source: { type: "base64" as const, data: "aW1hZ2U=", media_type: "image/png" } };
  turn.messages[0]?.content.push(image);
  turn.messages[1]?.content.push(image);
  const original = structuredClone(turn);
  const content = turn.messages.flatMap((message) => message.content);
  // The CLI forwards the same blocks; nothing is prefixed, suffixed, numbered or described.
  assert.deepEqual(content.filter((block) => block.type === "text").map((block) => block.text), ["ordered-input-0", "ordered-input-1", "ordered-input-2"]);
  assert.equal(content.filter((block) => block.type === "image").length, 2);
  const text = content.map((block) => block.type === "text" ? block.text : "").join("\n");
  for (const message of turn.messages) {
    assert(!text.includes(message.turnId)); assert(!text.includes(message.userMessageId)); assert(!text.includes(message.userId ?? ""));
  }
  assert.deepEqual(turn, original);
});

for (const harness of ["pi", "codex"] as const) test(`${harness}: multiple authors produce one native execution and archive under the last turn`, async () => {
  const root = await mkdtemp(join(tmpdir(), "native-batch-"));
  const turn = input(harness);
  const runtime = await testNativeRuntime({ spaceId: turn.spaceId, root, harnesses: [harness] });
  try {
    const { executor } = runtime.native;
    const requestId = randomUUID();
    const result = await executeTurn(executor, turn, () => {}, new AbortController().signal, requestId);
    const rows = (await readFile(result.session.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const prompts = rows.filter((row) => harness === "pi" ? row.type === "message" && row.message.role === "user" : row.payload?.item?.type === "UserMessage");
    assert.equal(prompts.length, 1, "one prompt for the entire batch");
    const payload = JSON.stringify(harness === "pi" ? prompts[0].message : prompts[0].payload.item.content);
    for (const message of turn.messages) {
      assert(!payload.includes(message.turnId)); assert(!payload.includes(message.userMessageId)); assert(!payload.includes(message.userId ?? ""));
    }
    assert(payload.indexOf("ordered-input-0") < payload.indexOf("ordered-input-1"));
    assert(payload.indexOf("ordered-input-1") < payload.indexOf("ordered-input-2"));
    // The native file itself names the cloud Turn, outside the model's input.
    const marker = harness === "pi" ? rows.find((row) => row.type === "custom")?.data?.turnId : prompts[0].payload.item.client_id;
    assert.equal(marker, turn.turnId);
    assert.equal(result.event.archive?.turnId, turn.turnId);
    await executor.results.record(result.session, turn, requestId, [result.event]);
    const replay = await executor.results.recover(turn, requestId);
    assert.deepEqual(replay?.events, JSON.parse(JSON.stringify([result.event])));
    await executor.results.acknowledge(turn.sessionId, turn.turnId);
    const next = await executor.sessions.prepare({ ...turn, cwd: root, context: { complete: false, revision: "completed", throughTurnId: turn.turnId, messages: [] }, resumable: () => true });
    assert.equal(next.resume, "native");
    assert.equal(next.session.path, result.session.path);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
