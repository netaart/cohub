#!/usr/bin/env node
// cursor-agent fixture mirroring the CLI's headless stream-json emitter, chat store and transcript layout.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const variant = process.env.CURSOR_FIXTURE ?? "";
// Like the CLI: unknown options fail first, then an invalid --new-session-id.
if (variant === "legacy" && args.includes("--conversation-history-file")) { process.stderr.write("error: unknown option '--conversation-history-file'\n"); process.exit(1); }
if (args[0] === "models") {
  if (variant === "signed-out") { process.stderr.write("Error: Authentication required.\n"); process.exit(1); }
  process.stdout.write("\x1b[2mAvailable models\x1b[0m\n\nauto - Auto (current, default)\ngpt-5 - GPT-5 (High)\n\nTip: use --model <id> to switch.\n");
  process.exit(0);
}
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
if (flag("--new-session-id") && !/^[0-9a-f-]{36}$/.test(flag("--new-session-id"))) { process.stderr.write(`Error: Invalid --new-session-id "${flag("--new-session-id")}": expected a UUIDv4.\n`); process.exit(1); }
const id = flag("--new-session-id") ?? flag("--resume");
const prompt = args[args.indexOf("--") + 1] ?? "";
const chat = join(process.env.CURSOR_CONFIG_DIR, "chats", createHash("md5").update(resolve(process.cwd())).digest("hex"), id);
const store = join(chat, "store.db");
if (flag("--resume") && !existsSync(store)) { process.stderr.write(`Chat ${id} not found\n`); process.exit(1); }
mkdirSync(chat, { recursive: true });
// Like the CLI, the model a run starts with becomes the saved default.
const config = join(process.env.CURSOR_CONFIG_DIR, "cli-config.json");
if (flag("--model") && existsSync(config)) writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), model: { modelId: flag("--model"), displayModelId: flag("--model") }, hasChangedDefaultModel: true }));
writeFileSync(join(chat, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: 1, hasConversation: true, cwd: process.cwd() }));
const imported = flag("--conversation-history-file") ? JSON.parse(readFileSync(flag("--conversation-history-file"), "utf8")).messages : [];
const history = [...(existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : []), ...imported];
writeFileSync(store, JSON.stringify([...history, { user: { content: [{ text: { text: prompt } }] } }]));
const project = process.cwd().replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
const transcript = join(process.env.CURSOR_DATA_DIR, "projects", project, "agent-transcripts", id, `${id}.jsonl`);
mkdirSync(join(transcript, ".."), { recursive: true });
const record = (value) => appendFileSync(transcript, `${JSON.stringify(value)}\n`);
const write = (value) => process.stdout.write(`${JSON.stringify({ ...value, session_id: id })}\n`);
const now = Date.now();
const text = (value, extra = {}) => write({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: value }] }, ...extra });

// A terminal Turn with the same prompt that ended just before this run started.
if (prompt === "same-before") {
  record({ role: "user", message: { content: [{ type: "text", text: "<user_query>\nsame-before\n</user_query>" }] } });
  record({ role: "assistant", message: { content: [{ type: "text", text: "another reply" }] } });
  record({ type: "turn_ended", status: "success" });
}
if (prompt === "die-early") { process.stderr.write("Error: died before recording\n"); process.exit(1); }
record({ role: "user", message: { content: [{ type: "text", text: "<workspace>open tabs</workspace>" }] } });
record({ role: "user", message: { content: [{ type: "text", text: `<timestamp>Saturday, Aug 01, 2026, 9:30 AM (UTC+8)</timestamp>\n<user_query>\n${prompt}\n</user_query>` }] } });
write({ type: "system", subtype: "init", apiKeySource: "login", cwd: process.cwd(), model: "Fixture Model", permissionMode: "default" });
write({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } });
if (prompt === "crash" || prompt === "wait") {
  process.on("SIGINT", () => { record({ type: "turn_ended", status: "aborted", error: "User aborted/interrupted manually." }); process.exit(130); });
  text("partial ", { timestamp_ms: now });
  text("reply", { timestamp_ms: now });
  if (prompt === "crash") { process.stderr.write("Error: backend went away\n"); process.exit(1); }
  setInterval(() => {}, 1_000);
} else {
  if (prompt.startsWith("sleep:")) await new Promise((resolve) => setTimeout(resolve, Number(prompt.slice(6))));
  const retained = JSON.stringify(history);
  const facts = [
    retained.includes("historical fact") && retained.includes("aGlzdG9yaWNhbCBpbWFnZQ==") && retained.includes('"toolCall"') ? "history retained" : "no history",
    ...(flag("--model") ? [`model:${flag("--model")}`] : []),
    ...(args.includes("--image") ? [`images:${args.filter((arg) => arg === "--image").length}`] : []),
  ].join(" ");
  // Partial output streams deltas, then repeats the step's text before the tool call and at the end.
  write({ type: "thinking", subtype: "delta", text: "plan", timestamp_ms: now });
  write({ type: "thinking", subtype: "completed", timestamp_ms: now });
  text("Run", { timestamp_ms: now });
  text("ning", { timestamp_ms: now });
  text("Running", variant === "call-ids" ? { timestamp_ms: now, model_call_id: "m1" } : { timestamp_ms: now });
  const call = { shellToolCall: { args: { command: "ls" } } };
  write({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: call, model_call_id: "m1", timestamp_ms: now });
  write({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { shellToolCall: { ...call.shellToolCall, result: { success: { stdout: "ok", exitCode: 0 } } } }, model_call_id: "m1", timestamp_ms: now });
  text(facts, { timestamp_ms: now });
  text(facts);
  record({ role: "assistant", message: { content: [{ type: "text", text: "Running" }, { type: "tool_use", name: "Shell", input: { command: "ls" } }] } });
  record({ role: "assistant", message: { content: [{ type: "text", text: facts }] } });
  record({ type: "turn_ended", status: "success" });
  // A terminal Turn in the same chat, written before Cohub reads the transcript back.
  if (prompt === "then-terminal") {
    record({ role: "user", message: { content: [{ type: "text", text: "<user_query>\nfrom the terminal\n</user_query>" }] } });
    record({ type: "turn_ended", status: "success" });
  }
  write({ type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false, result: `Running${facts}`, request_id: "r1", usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });
}
