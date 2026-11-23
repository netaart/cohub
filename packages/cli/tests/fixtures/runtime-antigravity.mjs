#!/usr/bin/env node
// A headless `agy`: `--help`, `models`, and `--input-format stream-json` Turns that write Antigravity's transcript.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const mode = process.env.ANTIGRAVITY_FIXTURE ?? "";
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

if (args[0] === "--help") {
  const flags = ["--conversation", "--dangerously-skip-permissions", "--effort", "--input-format", "--model", "--output-format", "--print", ...(mode === "old" ? [] : ["--settings"])];
  process.stderr.write(`Usage of agy:\n${flags.map((name) => `  ${name.padEnd(32)} description`).join("\n")}\n`);
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write("Fetching available models...\n");
  if (mode === "signed-out") {
    process.stderr.write("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n");
    process.exit(1);
  }
  process.stdout.write(`${["gemini-4-neon-high\tGemini 4 Neon (High)", "gemini-4-neon-low\tGemini 4 Neon (Low)", "gemini-pro-orchestrator\tOrchestrator (Carbon)", "claude-opus-5-5-max\tClaude Opus 5.5 (Max)"].join("\n")}\n`);
  process.exit(0);
}
if (flag("--input-format") !== "stream-json" || flag("--output-format") !== "stream-json") {
  process.stderr.write(`Unexpected args: ${args.join(" ")}\n`);
  process.exit(2);
}

const settings = flag("--settings") ? JSON.parse(readFileSync(flag("--settings"), "utf8")) : {};
const deny = settings.permissions?.deny ?? [];
const skip = args.includes("--dangerously-skip-permissions");
if (process.env.ANTIGRAVITY_FIXTURE_LOG) appendFileSync(process.env.ANTIGRAVITY_FIXTURE_LOG, `${JSON.stringify({ args, settings })}\n`);

const appData = join(homedir(), ".gemini", "antigravity-cli");
const transcriptOf = (id) => join(appData, "brain", id, ".system_generated", "logs", "transcript.jsonl");
const requested = flag("--conversation");
const conversation = requested && existsSync(transcriptOf(requested)) ? requested : randomUUID();
if (requested && conversation !== requested) process.stderr.write(`warning: conversation "${requested}" not found\n`);
const transcript = transcriptOf(conversation);
mkdirSync(join(transcript, ".."), { recursive: true });
const db = new DatabaseSync(join(appData, "conversation_summaries.db"));
db.exec("CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id text PRIMARY KEY, workspace_uris text NOT NULL, parent_conversation_id text NOT NULL DEFAULT '', nesting_depth integer NOT NULL DEFAULT 0)");
db.prepare("INSERT OR IGNORE INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)").run(conversation, JSON.stringify([pathToFileURL(process.cwd()).href]));
db.close();

let step = existsSync(transcript) ? readFileSync(transcript, "utf8").split("\n").filter(Boolean).length : 0;
const at = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const record = (value) => appendFileSync(transcript, `${JSON.stringify({ step_index: step, created_at: at(), status: "DONE", ...value })}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const update = (value) => send({ event: "step_update", step_update: { conversation_id: conversation, step_index: step, state: "DONE", ...value } });
const usage = { input_tokens: 12, output_tokens: 5, thinking_tokens: 1, cache_read_tokens: 2, total_tokens: 17 };
const result = (value) => send({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response: "", num_turns: 1, usage: { ...usage, input_tokens: 999 }, ...value } });

send({ event: "init", conversation_id: conversation, init: { cwd: process.cwd(), tools: ["run_command"], permission_mode: skip ? "always-proceed" : "request-review", ...(flag("--model") ? { model: flag("--model") } : {}) } });

function reply(text) {
  record({ source: "MODEL", type: "PLANNER_RESPONSE", model: flag("--model") ?? "gemini-4-neon-high", input_tokens: 12, cache_read_tokens: 2, output_tokens: 5, content: text });
  update({ step_type: "agent_response", text_delta: `${text}\n`, usage });
  step++;
  return text;
}

function command(line) {
  record({ source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 12, cache_read_tokens: 2, output_tokens: 5, tool_calls: [{ name: "run_command", args: { CommandLine: JSON.stringify(line) } }] });
  update({ step_type: "agent_response", usage });
  step++;
  const tool = { name: "run_command", parameters: { CommandLine: line } };
  update({ step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: tool });
  if (deny.includes("command(*)")) {
    const error = `permission check failed for command "${line}": Matches user-configured deny rule.`;
    record({ source: "MODEL", type: "GENERIC", status: "ERROR", error });
    update({ step_type: "tool", tool_name: "run_command", tool_info: { ...tool, error: { type: "permission", message: error } } });
    step++;
    return { response: reply("denied by rule") };
  }
  if (!skip) {
    update({ step_type: "tool", tool_name: "run_command", tool_info: tool });
    step++;
    return { response: "", denied_actions: [{ action: "command", display_name: "Bash" }] };
  }
  record({ source: "MODEL", type: "GENERIC", content: "ran" });
  update({ step_type: "tool", tool_name: "run_command", tool_info: { ...tool, output: "ran\n" } });
  step++;
  return { response: reply("command done") };
}

let busy = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  busy = busy.then(async () => {
    const content = JSON.parse(line).message.content;
    record({ source: "USER_EXPLICIT", type: "USER_INPUT", content: `<USER_REQUEST>\n${content}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${at()}.\n</ADDITIONAL_METADATA>` });
    update({ step_type: "user_input" });
    step++;
    if (content.includes("need-cmd")) return result(command("echo hello"));
    if (content.includes("sleep")) {
      let interrupted = false;
      process.once("SIGINT", () => { interrupted = true; });
      for (let index = 0; !interrupted && index < 100; index++) {
        update({ step_type: "agent_response", state: "ACTIVE", text_delta: `part${index} ` });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      result({ status: "ERROR", error: "interrupted", response: "part0" });
      process.exit(130);
    }
    const history = /<cohub_session_history>([\s\S]*?)<\/cohub_session_history>/.exec(content)?.[1] ?? "";
    const images = [...content.matchAll(/^- (.+image-\d+\.\w+)$/gm)].filter((match) => existsSync(match[1])).length;
    const facts = [...history.matchAll(/fact-\w+/g)].map((match) => match[0]).join(",") || "none";
    const answer = { response: reply(`history:${facts} model:${flag("--model") ?? "default"} effort:${flag("--effort") ?? "none"} skip:${skip} images:${images}`) };
    result(answer);
    if (content.includes("then-terminal")) {
      // Another client continues the same conversation with an identical prompt before this process exits.
      record({ source: "USER_EXPLICIT", type: "USER_INPUT", content: `<USER_REQUEST>\n${content}\n</USER_REQUEST>` });
      step++;
      reply("terminal reply");
    }
  });
});
input.on("close", () => { void busy.then(() => process.exit(0)); });
