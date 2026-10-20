#!/usr/bin/env node
// Claude Code / CodeBuddy-compatible stream-json fixture: one Turn per process. CODEBUDDY_CONFIG_DIR selects CodeBuddy's layout.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--help") {
  const variant = process.env.STREAM_JSON_FIXTURE_HELP;
  const flags = ["--input-format", "--output-format", "--include-partial-messages", "--session-id", "--resume", "--permission-mode", "--strict-mcp-config", "--effort", ...(variant === "legacy" ? [] : ["--tools <tools...>"])];
  const models = variant === "no-models" ? "" : "fixture-a, fixture-b";
  process.stdout.write(`${flags.map((flag) => `  ${flag}  option\n`).join("")}  --model <model>  Model for the session. Currently supported: (${models})\n`);
  process.exit(0);
}
if (!args.includes("--session-id") && !args.includes("--resume")) {
  // Model discovery: answer `initialize` like Claude Code, gateway models included.
  if (process.env.STREAM_JSON_FIXTURE_HELP === "no-initialize") process.exit(1);
  for await (const line of createInterface({ input: process.stdin })) {
    const { request_id } = JSON.parse(line);
    const models = [
      { value: "default", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
      { value: "opus", displayName: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
      { value: "gw-model", displayName: "gateway-model", description: "From gateway", supportsEffort: false },
    ];
    process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id, response: { models } } })}\n`);
  }
  process.exit(0);
}
const codebuddy = process.env.CODEBUDDY_CONFIG_DIR;
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const id = flag("--session-id") ?? flag("--resume");
const directory = codebuddy
  ? join(codebuddy, "projects", process.cwd().replace(/[/\\:]/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-"))
  : join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
const file = join(directory, `${id}.jsonl`);
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// Like Claude Code, an empty transcript is no conversation to resume.
if (flag("--resume") && (!existsSync(file) || !readFileSync(file, "utf8").trim())) {
  write({ type: "result", subtype: "error_during_execution", is_error: true, errors: [`No conversation found with session ID: ${id}`] });
  process.exit(1);
}
const history = existsSync(file) ? readFileSync(file, "utf8") : "";
mkdirSync(directory, { recursive: true });
const record = (value) => appendFileSync(file, `${JSON.stringify({ sessionId: id, ...value })}\n`);
let waiting = false;
for await (const line of createInterface({ input: process.stdin })) {
  const prompt = JSON.parse(line);
  if (prompt.type === "control_request" && prompt.request?.subtype === "interrupt" && waiting) {
    write({ type: "result", subtype: "error_during_execution", is_error: true, result: "Request interrupted by user", session_id: id });
    continue;
  }
  record({ type: "user", uuid: "u1", message: prompt.message });
  write({ type: "system", subtype: "init", session_id: id, model: "fixture-model" });
  const said = JSON.stringify(prompt);
  if (said.includes("crash") || said.includes("wait")) {
    write({ type: "stream_event", event: { type: "message_start", message: { id: "m0" } } });
    write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial " } } });
    write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "reply" } } });
    if (said.includes("crash")) process.exit(1);
    waiting = true;
    continue;
  }
  const tools = flag("--tools") ? ` tools:${flag("--tools")}${args.includes("--strict-mcp-config") ? " no-mcp" : ""}` : "";
  const options = `${flag("--model") ? ` model:${flag("--model")}` : ""}${flag("--effort") ? ` effort:${flag("--effort")}` : ""}`;
  const answer = `${history.includes("historical fact") && history.includes("aGlzdG9yaWNhbCBpbWFnZQ") ? "history retained" : "no history"} ${flag("--permission-mode")}${tools}${options}`;
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
