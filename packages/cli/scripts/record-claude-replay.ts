/** Records real Claude Code output against a loopback model: `record-claude-replay.ts <claude binary>`. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Reply = { text: string } | { tool: { name: string; input: Record<string, unknown> } } | { limited: number };
const SCENARIOS: Record<string, { prompts: string[]; replies: Reply[] }> = {
  text: { prompts: ["say hello"], replies: [{ text: "Hello from the fixture." }] },
  tool: { prompts: ["read notes.txt"], replies: [{ tool: { name: "Read", input: { file_path: "<cwd>/notes.txt" } } }, { text: "The notes say: remember." }] },
  turns: { prompts: ["first", "second"], replies: [{ text: "First answer." }, { text: "Second answer." }] },
  usage_limit: { prompts: ["anything"], replies: [{ limited: 1_900_000_000 }] },
};

function stream(response: ServerResponse, model: string, reply: Reply, id: number) {
  if ("limited" in reply) {
    response.writeHead(429, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(reply.limited),
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
    });
    response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Usage limit reached" } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { id: `msg_${id}`, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  if ("text" in reply) {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const part of reply.text.split(/(?<= )/)) send("content_block_delta", { index: 0, delta: { type: "text_delta", text: part } });
  } else {
    send("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${id}`, name: reply.tool.name, input: {} } });
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.tool.input) } });
  }
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "text" in reply ? "end_turn" : "tool_use" }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  response.end();
}

async function record(claude: string, name: string, scenario: (typeof SCENARIOS)[string]) {
  const cwd = await mkdtemp(join(tmpdir(), "claude-replay-cwd-"));
  const config = await mkdtemp(join(tmpdir(), "claude-replay-config-"));
  try { return await recordIn(claude, name, scenario, cwd, config); }
  finally { await Promise.all([rm(cwd, { recursive: true, force: true }), rm(config, { recursive: true, force: true })]); }
}

async function recordIn(claude: string, name: string, scenario: (typeof SCENARIOS)[string], cwd: string, config: string) {
  await writeFile(join(cwd, "notes.txt"), "remember\n");
  const replies = scenario.replies.map((reply) => JSON.parse(JSON.stringify(reply).replaceAll("<cwd>", cwd)) as Reply);
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body || "{}") as { stream?: boolean; model?: string };
    if (!parsed.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: "side", type: "message", role: "assistant", model: parsed.model, content: [{ type: "text", text: "side" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })); return; }
    const reply = replies[requests++] ?? { text: "(no more replies)" };
    stream(response, parsed.model ?? "model", reply, requests);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ANTHROPIC_") && !key.startsWith("CLAUDE")));
  const port = (server.address() as { port: number }).port;
  const child = spawn(claude, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--session-id", randomUUID(), "--permission-mode", "acceptEdits", "--model", "claude-haiku-4-5"], {
    cwd, stdio: ["pipe", "pipe", "inherit"],
    env: { ...env, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-replay", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_MAX_RETRIES: "0" },
  });
  const scrub = (line: string) => line.replaceAll(cwd, "<cwd>").replaceAll(config, "<config>").replaceAll(`127.0.0.1:${port}`, "<model>")
    .replace(new RegExp(`${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^"]*`, "g"), "<tmp>");
  const lines: string[] = [];
  const prompts = [...scenario.prompts];
  const send = () => child.stdin.write(`${JSON.stringify({ type: "user", uuid: randomUUID(), message: { role: "user", content: prompts.shift() } })}\n`);
  send();
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    const frame = JSON.parse(scrub(line)) as { type?: string };
    lines.push(JSON.stringify({ scenario: name, frame }));
    if (frame.type === "result") { if (prompts.length) send(); else child.stdin.end(); }
  }
  server.close();
  if (!requests) throw new Error(`${claude} sent no request to the loopback model`);
  return lines;
}

const claude = process.argv[2];
if (!claude) throw new Error("Pass the path of the Claude Code binary");
// A wrapper script may route requests to a real account.
const handle = await open(claude);
const magic = Buffer.alloc(2);
await handle.read(magic, 0, 2, 0).finally(() => handle.close());
if (magic.toString() === "#!") throw new Error(`${claude} is a script; pass the Claude Code binary itself`);
const lines: string[] = [];
for (const [name, scenario] of Object.entries(SCENARIOS)) lines.push(...await record(claude, name, scenario));
const target = new URL("../tests/fixtures/replay/claude.ndjson", import.meta.url);
await writeFile(target, `${lines.join("\n")}\n`);
console.log(`Recorded ${lines.length} frames to ${target.pathname}`);
