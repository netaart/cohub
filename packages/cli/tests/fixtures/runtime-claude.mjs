#!/usr/bin/env node
// Claude Code-compatible stream-json fixture: one Turn per process, transcript under CLAUDE_CONFIG_DIR.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("9.9.9 (fixture)\n"); process.exit(0); }
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const id = flag("--session-id") ?? flag("--resume");
const directory = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
const file = join(directory, `${id}.jsonl`);
if (flag("--resume") && !existsSync(file)) { process.stderr.write("No conversation found\n"); process.exit(1); }
const history = existsSync(file) ? readFileSync(file, "utf8") : "";
mkdirSync(directory, { recursive: true });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const record = (value) => appendFileSync(file, `${JSON.stringify({ sessionId: id, ...value })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const prompt = JSON.parse(line);
  record({ type: "user", uuid: "u1", message: prompt.message });
  write({ type: "system", subtype: "init", session_id: id, model: "fixture-model" });
  const answer = `${history.includes("historical fact") ? "history retained" : "no history"} ${flag("--permission-mode")}`;
  write({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
  write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Run" } } });
  write({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Running" }] } });
  write({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } });
  write({ type: "assistant", parent_tool_use_id: "t1", message: { id: "sub", content: [{ type: "text", text: "sub-agent" }] } });
  write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  write({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: answer }] } });
  record({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m2", role: "assistant", content: [{ type: "text", text: answer }] } });
  write({ type: "result", subtype: "success", is_error: false, result: answer, session_id: id, usage: { input_tokens: 3, output_tokens: 2 } });
}
