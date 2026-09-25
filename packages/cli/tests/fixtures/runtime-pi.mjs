#!/usr/bin/env node
// A stand-in for `pi --mode rpc`: it answers the RPC calls Cohub makes and hosts the real Cohub
// extension (passed with -e) through a minimal copy of Pi's extension API. Node strips the types
// of the TypeScript extension source on import.
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// The version this stand-in speaks for; the Runtime refuses to drive an older Pi.
if (process.argv.includes("--version")) { process.stdout.write("0.86.1\n"); process.exit(0); }
const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const path = option("--session");
const extensionPath = option("-e");
const send = (value) => {
  const data = Buffer.from(`${JSON.stringify(value)}\n`);
  for (let offset = 0; offset < data.length; offset += 3) process.stdout.write(data.subarray(offset, offset + 3));
};
const model = { provider: "fixture", id: "test", name: "Test" };
const rows = path ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
const sessionId = rows[0]?.id ?? "discovery";
let leaf = rows.at(-1)?.id ?? null;
const append = (entry) => {
  const id = randomUUID();
  appendFileSync(path, `${JSON.stringify({ ...entry, id, parentId: leaf, timestamp: new Date().toISOString() })}\n`);
  leaf = id;
};

const handlers = new Map();
let running = null;
const context = {
  cwd: process.cwd(),
  sessionManager: { getSessionFile: () => path, getSessionId: () => sessionId },
  isIdle: () => running === null,
  abort: () => running?.finish("aborted"),
};
const emit = async (type, event = {}) => { for (const handler of handlers.get(type) ?? []) await handler({ ...event, type }, context); };

async function runTurn(content) {
  const text = typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const history = readFileSync(path, "utf8");
  await emit("agent_start");
  append({ type: "message", message: { role: "user", content } });
  await emit("message_start", { message: { role: "user" } });
  await emit("message_end", { message: { role: "user", content } });
  await emit("message_start", { message: { role: "assistant" } });
  const answer = history.includes("historical") ? "history retained" : "new session";
  await emit("message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好 " } });
  await emit("message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: answer } });
  await new Promise((resolve) => {
    let done = false;
    const finish = async (stopReason) => {
      if (done) return;
      done = true;
      const message = { role: "assistant", content: [{ type: "text", text: `你好 ${answer}` }], provider: "fixture", model: "test", stopReason };
      append({ type: "message", message });
      await emit("message_end", { message });
      await emit("turn_end", { message, toolResults: [] });
      running = null;
      await emit("agent_end", { messages: [] });
      await emit("agent_settled");
      resolve();
    };
    running = { finish };
    if (text.includes("wait for abort")) return;
    setTimeout(() => void finish("stop"), text.includes("slow transport test") ? 250 : 0);
  });
}

if (extensionPath) {
  const extension = (await import(pathToFileURL(extensionPath).href)).default;
  extension({
    on: (type, handler) => handlers.set(type, [...(handlers.get(type) ?? []), handler]),
    sendUserMessage: (content) => { void runTurn(content); },
    appendEntry: (customType, data) => append({ type: "custom", customType, data }),
  });
  await emit("session_start", { reason: "startup" });
}

for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  const respond = (data = {}) => send({ id: input.id, type: "response", success: true, data });
  if (input.type === "get_available_models") respond({ models: [model] });
  else if (input.type === "get_state") respond({ sessionId, model, isStreaming: running !== null });
  else respond();
}
