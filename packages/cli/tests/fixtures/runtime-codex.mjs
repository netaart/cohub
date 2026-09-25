#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
if (!process.argv.includes("app-server")) throw new Error("Expected app-server");
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (input, result) => send({ id: input.id, result });
let thread;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const input = JSON.parse(line);
  if (input.method === "initialize") respond(input, { userAgent: "fixture" });
  else if (input.method === "config/read") respond(input, { config: { model: "test", model_provider: "fixture" } });
  else if (input.method === "model/list") respond(input, { data: [{ id: "test", model: "test", displayName: "Test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], nextCursor: null });
  else if (input.method === "thread/start") {
    const id = randomUUID();
    thread = { id, path: join(process.cwd(), `native-${id}.jsonl`) };
    writeFileSync(thread.path, `${JSON.stringify({ type: "session_meta", payload: { id, session_id: id, cwd: process.cwd(), history_mode: "paginated" } })}\n`);
    respond(input, { thread, model: "test", modelProvider: "fixture" });
  } else if (input.method === "thread/fork") {
    const data = readFileSync(input.params.path, "utf8").trimEnd().split("\n");
    const header = JSON.parse(data[0]);
    if (header.payload.history_mode !== "legacy" || header.payload.session_id !== header.payload.id) throw new Error("Archived projection must be portable and independent from the private index");
    const id = randomUUID();
    header.payload.id = id;
    header.payload.forked_from_id = input.params.threadId;
    thread = { id, path: join(process.cwd(), `native-${id}.jsonl`) };
    writeFileSync(thread.path, `${[JSON.stringify(header), ...data.slice(1)].join("\n")}\n`);
    respond(input, { thread, model: "test", modelProvider: "fixture" });
  } else if (input.method === "thread/resume") {
    const path = input.params.path || join(process.cwd(), `native-${input.params.threadId}.jsonl`);
    const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]);
    thread = { id: header.payload.id, path };
    respond(input, { thread, model: "test", modelProvider: "fixture" });
  } else if (input.method === "turn/start") {
    const id = randomUUID();
    const answer = JSON.stringify(input.params.input).includes("historical") ? "history retained" : "native resumed";
    const timestamp = new Date().toISOString();
    const record = (type, payload) => appendFileSync(thread.path, `${JSON.stringify({ timestamp, type, payload })}\n`);
    // The rollout records the Turn the way Codex does, including the client's id for the prompt.
    record("event_msg", { type: "turn_started", turn_id: id });
    record("event_msg", { type: "item_completed", item: { type: "UserMessage", client_id: input.params.clientUserMessageId ?? null, content: input.params.input.map((block) => block.type === "text" ? { type: "input_text", text: block.text } : block) } });
    record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] });
    record("event_msg", { type: "turn_complete", turn_id: id, last_agent_message: answer });
    respond(input, { turn: { id } });
    send({ method: "turn/started", params: { threadId: thread.id, turn: { id } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: thread.id, turnId: id, tokenUsage: { total: { inputTokens: 1100, outputTokens: 505, cachedInputTokens: 110, totalTokens: 1605 }, last: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 10, totalTokens: 105 } } } });
    send({ method: "item/started", params: { threadId: thread.id, item: { id: "reason", type: "reasoning" } } });
    send({ method: "item/reasoning/textDelta", params: { threadId: thread.id, itemId: "reason", delta: "thinking" } });
    send({ method: "item/started", params: { threadId: thread.id, item: { id: "answer", type: "agentMessage" } } });
    send({ method: "item/agentMessage/delta", params: { threadId: thread.id, itemId: "answer", delta: answer } });
    send({ method: "item/completed", params: { threadId: thread.id, item: { id: "reason", type: "reasoning", content: ["thinking"] } } });
    send({ method: "item/started", params: { threadId: thread.id, item: { id: "answer", type: "agentMessage", text: answer } } });
    send({ method: "item/completed", params: { threadId: thread.id, item: { id: "answer", type: "agentMessage", text: answer } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: thread.id, turnId: id, tokenUsage: { total: { inputTokens: 1140, outputTokens: 512, cachedInputTokens: 115, totalTokens: 1652 }, last: { inputTokens: 40, outputTokens: 7, cachedInputTokens: 5, totalTokens: 47 } } } });
    send({ method: "turn/completed", params: { threadId: thread.id, turn: { id, status: "completed" } } });
  }
}
