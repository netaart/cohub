import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { readNativeTranscript } from "../src/runtime/native/transcript.js";
const row = (type: string, payload: unknown) => ({ timestamp: "2026-10-12T00:00:00.000Z", type, payload });
const start = row("event_msg", { type: "task_started", turn_id: "turn" });
const legacy = (message: string, client_id: string) => row("event_msg", { type: "user_message", message, client_id });
const typed = (text: string, client_id: string, image = false) => row("event_msg", { type: "item_completed", item: { type: "UserMessage", client_id, content: [{ type: "text", text }, ...(image ? [{ type: "local_image", path: "/original.png" }] : [])] } });
const image = { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" };
const response = (text: string, includeImage = false) => row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }, ...(includeImage ? [image] : [])] });
const answer = (text: string) => row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const end = row("event_msg", { type: "task_complete", turn_id: "turn" });
async function parse(rows: ReturnType<typeof row>[]) {
  const root = await mkdtemp(join(tmpdir(), "cohub-native-inputs-"));
  try {
    const path = join(root, "session.jsonl");
    await writeFile(path, [row("session_meta", { id: "11111111-1111-4111-8111-111111111111", cwd: root }), start, ...rows].map(x => JSON.stringify(x)).join("\n") + "\n");
    return (await readNativeTranscript(path, "codex")).turns.at(-1)!;
  } finally { await rm(root, { recursive: true }); }
}
const plain = (content: any[]) => content.map(({ _meta, ...block }) => block);
const expectedImage = { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } };
test("legacy event-first input waits for its rich response and retains original images", async () => {
  const pending = await parse([legacy("Look", "original")]);
  assert.notEqual(pending.userFinal, true, "The simplified marker cannot lock out its following image");
  const rich = await parse([legacy("Look", "original"), response("Look", true)]);
  assert.notEqual(rich.userFinal, true, "A typed marker can still supply the original client id");
  const running = await parse([legacy("Look", "original"), response("Look", true), answer("First answer")]);
  const done = await parse([legacy("Look", "original"), response("Look", true), answer("First answer"), typed("Correction", "later"), end]);
  assert.equal(running.userFinal, true);
  assert.deepEqual(running.userContent, [{ type: "text", text: "Look" }, expectedImage]);
  assert.deepEqual(done.userContent, running.userContent);
  assert.equal(done.cloudTurnId, "original");
});
test("typed image input keeps rich bytes and later question replies and images in order", async () => {
  const reply = '<send_user_message_question_reply>[{"question":"Continue?","answer":"Yes"}]</send_user_message_question_reply>';
  const turn = await parse([response("Look", true), typed("Look", "original", true), answer("First answer"), response(reply), typed(reply, "reply"), response("Correction", true), typed("Correction", "image", true), answer("Final answer"), end]);
  assert.deepEqual(turn.userContent, [{ type: "text", text: "Look" }, expectedImage]);
  assert.equal(turn.cloudTurnId, "original");
  assert.deepEqual(turn.messages.map(m => plain(m.content)), [[{ type: "text", text: "First answer" }], [{ type: "text", text: reply }], [{ type: "text", text: "Correction" }, expectedImage], [{ type: "text", text: "Final answer" }]]);
  assert.equal(turn.messages[1].content[0]._meta?.nativeUserMessage, true);
  assert.equal(turn.messages[2].content[1]._meta?.nativeUserMessage, true);
  assert.notEqual(turn.messages[3].content[0]._meta?.nativeUserMessage, true);
});
test("legacy steering retains input once across response duplication and repeated text", async () => {
  const turn = await parse([legacy("Original", "original"), response("Original"), answer("Working"), legacy("Again", "a"), response("Again"), legacy("Again", "b"), response("Again"), answer("Done"), end]);
  assert.deepEqual(turn.messages.map(m => plain(m.content)), [[{ type: "text", text: "Working" }], [{ type: "text", text: "Again" }], [{ type: "text", text: "Again" }], [{ type: "text", text: "Done" }]]);
});
test("resume steering retains input without replacing its empty initial request", async () => {
  const turn = await parse([row("event_msg", { type: "task_started", turn_id: "resumed", turn_attribution: { turn_trigger: "app_update_resume" } }), answer("Working"), legacy("Correction", "later"), answer("Updated"), row("event_msg", { type: "task_complete", turn_id: "resumed" })]);
  assert.deepEqual(turn.userContent, []);
  assert.equal(turn.cloudTurnId, undefined);
  assert.deepEqual(turn.messages.map(m => plain(m.content)), [[{ type: "text", text: "Working" }], [{ type: "text", text: "Correction" }], [{ type: "text", text: "Updated" }]]);
});
test("response-first legacy input excludes injected context and preserves its image", async () => {
  const turn = await parse([response("<environment_context/>"), response("Look", true), legacy("Look", "original"), answer("Done"), end]);
  assert.deepEqual(turn.userContent, [{ type: "text", text: "Look" }, expectedImage]);
  assert.equal(turn.messages.length, 1);
});
test("duplicate user ids do not add another user message or overwrite the original identity", async () => {
  const turn = await parse([response("Look", true), legacy("Look", "original"), typed("Look", "original", true), answer("Done"), row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Next" }] }), typed("Next", "later"), typed("Next", "later"), end]);
  assert.deepEqual(turn.userContent, [{ type: "text", text: "Look" }, expectedImage]);
  assert.equal(turn.cloudTurnId, "original");
  assert.equal(turn.messages.filter(m => m.content[0]?._meta?.nativeUserMessage).length, 1);
});
test("a missing original image fails explicitly instead of silently losing the attachment", async () => {
  await assert.rejects(parse([typed("Look", "original", true), answer("Done"), end]), /image content is missing/);
});
test("image resize developer notices between rich input and typed marker preserve image bytes", async () => {
  const turn = await parse([response("Look", true), row("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "Image resized" }] }), typed("Look", "original", true), answer("Done"), end]);
  assert.deepEqual(turn.userContent, [{ type: "text", text: "Look" }, expectedImage]);
});
test("legacy steering is visible immediately and gains its rich image without another message", async () => {
  const prefix = [typed("Original", "original"), answer("Working"), legacy("Correction", "later")];
  const partial = await parse(prefix);
  assert.deepEqual(plain(partial.messages.at(-1)!.content), [{ type: "text", text: "Correction" }]);
  assert.equal(partial.messages.at(-1)!.content[0]._meta?.nativeUserMessage, true);
  const rich = await parse([...prefix, response("Correction", true)]);
  assert.equal(rich.messages.length, partial.messages.length);
  assert.deepEqual(plain(rich.messages.at(-1)!.content), [{ type: "text", text: "Correction" }, expectedImage]);
});
test("legacy marker without a client id and typed final marker describe one original rich input", async () => {
  const turn = await parse([row("event_msg", { type: "user_message", message: "Look" }), response("Look", true), typed("Look", "original", true), answer("Done"), end]);
  assert.deepEqual(turn.userContent, [{ type: "text", text: "Look" }, expectedImage]);
  assert.equal(turn.cloudTurnId, "original");
  assert.deepEqual(turn.messages.map(m => plain(m.content)), [[{ type: "text", text: "Done" }]]);
});
