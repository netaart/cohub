// Native integration smoke with isolated homes and a deterministic loopback model fixture. No real credentials or external model calls.
// COHUB_NATIVE_PI_BIN=/path/to/pi COHUB_NATIVE_CODEX_BIN=/path/to/codex node packages/cli/scripts/test-native-plugins.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const pi = process.env.COHUB_NATIVE_PI_BIN, codex = process.env.COHUB_NATIVE_CODEX_BIN;
if (!pi && !codex) throw new Error("Set COHUB_NATIVE_PI_BIN and/or COHUB_NATIVE_CODEX_BIN");
const home = await mkdtemp(join(tmpdir(), "cohub-native-plugins-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COHUB_") && !/(TOKEN|SECRET|API_KEY|DATABASE_URL|REDIS_URL)/.test(key)));
Object.assign(env, { HOME: home, PI_CODING_AGENT_DIR: join(home, "pi"), CODEX_HOME: join(home, "codex"), OTEL_SDK_DISABLED: "true", NODE_OPTIONS: "" });
// Exercise the published JS layout, not workspace TS aliases inside the native client's loader.
const cli = join(home, "cli"), sdk = join(cli, "node_modules", "@neta-art", "cohub");
await mkdir(sdk, { recursive: true });
await cp(new URL("../dist", import.meta.url), join(cli, "dist"), { recursive: true });
await cp(new URL("../../sdk/dist", import.meta.url), join(sdk, "dist"), { recursive: true });
const sdkManifest = JSON.parse(await readFile(new URL("../../sdk/package.json", import.meta.url), "utf8"));
await writeFile(join(cli, "package.json"), JSON.stringify({ type: "module" }));
await writeFile(join(sdk, "package.json"), JSON.stringify({ ...sdkManifest, ...sdkManifest.publishConfig }));
await symlink(fileURLToPath(new URL("../../sdk/node_modules", import.meta.url)), join(sdk, "node_modules"));
const { codexNativeHookBlock } = await import(pathToFileURL(join(cli, "dist", "runtime", "native-install.js")).href);
const root = join(home, "project");
await mkdir(root);
await writeFile(join(root, "AGENTS.md"), "Use fixture conventions only.\n");
const modelServer = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Drain fixture input, never log prompts. */ }
  if (request.method !== "POST") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":[]}'); return; }
  const item = { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture answer", annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "fixture answer" },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "fixture answer" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;

function rpc(binary, args, mode) {
  const child = spawn(binary, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const pending = new Map();
  const seen = [];
  let sequence = 0, buffer = "", stderr = "";
  child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-4000); });
  child.stdout.on("data", (bytes) => {
    buffer += bytes;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      seen.push(response);
      pending.get(response.id)?.(response);
    }
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  return {
    events: seen,
    notify: (method) => child.stdin.write(`${JSON.stringify({ method, params: {} })}\n`),
    request: (method, params = {}, timeoutMs = 15_000) => new Promise((resolve, reject) => {
      const id = `cohub-smoke-${++sequence}`;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}\n${stderr}\n${JSON.stringify(seen.slice(-3))}`)); }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timeout); pending.delete(id);
        if (response.error || response.success === false) reject(new Error(JSON.stringify(response.error ?? response)));
        else resolve(mode === "pi" ? response.data : response.result);
      });
      child.stdin.write(`${JSON.stringify(mode === "pi" ? { type: method, id, ...params } : { method, id, params })}\n`);
    }),
    async close() {
      if (mode === "pi") child.kill("SIGTERM"); else child.stdin.end();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      await closed; clearTimeout(timeout);
      // Native startup helpers belong to this fixture's process group, not to the user's Runtime.
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      assert(!/Failed to load extension/.test(stderr), stderr);
      assert(!seen.some((event) => event.type === "extension_error"), JSON.stringify(seen.filter((event) => event.type === "extension_error")));
    },
  };
}
try {
  if (pi) {
    const extension = join(cli, "dist", "runtime", "native-pi-extension.js");
    const provider = join(home, "provider.mjs"), sessionFile = join(home, "pi-session.jsonl");
    await writeFile(provider, `export default (pi) => pi.registerProvider('cohub-fixture', {baseUrl:${JSON.stringify(modelUrl)},api:'openai-responses',apiKey:'fixture',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:128000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});`);
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: root })}\n`);
    const peer = rpc(pi, ["--mode", "rpc", "--session", sessionFile, "-e", provider, "-e", extension], "pi");
    try {
      // Pi attaches its RPC reader after extension initialization.
      await delay(3000);
      let state;
      for (let attempt = 0; attempt < 10 && !state; attempt++) {
        try { state = await peer.request("get_state", {}, 1500); }
        catch (error) { if (attempt === 9) throw error; }
      }
      assert.equal(state.isStreaming, false);
      assert.equal(state.messageCount, 0);
      await peer.request("set_model", { provider: "cohub-fixture", modelId: "fixture" });
      await peer.request("prompt", { message: "native sync smoke" });
      for (let attempt = 0; attempt < 150 && !peer.events.some((event) => event.type === "agent_settled"); attempt++) await delay(100);
      assert(peer.events.some((event) => event.type === "agent_settled"), JSON.stringify(peer.events.slice(-5)));
      const { readNativeTranscript } = await import(pathToFileURL(join(cli, "dist", "runtime", "native-transcript.js")).href);
      const transcript = await readNativeTranscript(sessionFile, "pi", { settled: true });
      assert.equal(transcript.turns.at(-1)?.result?.status, "completed");
      assert(transcript.turns.at(-1).result.messages.some((message) => message.content.some((block) => block.text === "fixture answer")));
      console.log("Pi extension/RPC/Turn transcript: passed (loopback fixture only)");
    } finally { await peer.close(); }
  }
  if (codex) {
    await mkdir(env.CODEX_HOME);
    const hook = join(home, "hook.mjs"), log = join(home, "hooks.jsonl");
    const moduleUrl = pathToFileURL(join(cli, "dist", "runtime", "native-codex-hook.js")).href;
    await writeFile(hook, `import {runCodexNativeHook} from ${JSON.stringify(moduleUrl)}; import {appendFile} from 'node:fs/promises'; let raw=''; for await(const bytes of process.stdin) raw+=bytes; const event=JSON.parse(raw); await appendFile(${JSON.stringify(log)}, JSON.stringify(event.hook_event_name)+'\\n'); await runCodexNativeHook(event);`);
    const configPath = join(env.CODEX_HOME, "config.toml");
    // Explicit table boundaries keep provider configuration outside the last hook array item.
    await writeFile(configPath, `model = "gpt-5"\nmodel_provider = "offline"\n${codexNativeHookBlock(process.execPath, hook)}\n[features]\nplugins = false\nrecommended_plugins = false\n[model_providers.offline]\nname = "Offline fixture"\nbase_url = ${JSON.stringify(modelUrl)}\nwire_api = "responses"\n`);
    let peer = rpc(codex, ["app-server", "--listen", "stdio://"], "codex");
    try {
      await peer.request("initialize", { clientInfo: { name: "cohub-native-smoke", version: "1" }, capabilities: { experimentalApi: true } });
      peer.notify("initialized");
      const listed = await peer.request("hooks/list", { cwd: root });
      const hooks = listed.data.flatMap((entry) => entry.hooks);
      assert.equal(hooks.length, 6);
      assert.deepEqual(listed.data.flatMap((entry) => entry.errors ?? []), []);
      // Trust only these exact fixture commands. The installer never writes trust overrides.
      await appendFile(configPath, hooks.map((item) => `\n[hooks.state.${JSON.stringify(item.key)}]\ntrusted_hash = ${JSON.stringify(item.currentHash)}\n`).join(""));
      await peer.close();
      peer = rpc(codex, ["app-server", "--listen", "stdio://"], "codex");
      await peer.request("initialize", { clientInfo: { name: "cohub-native-smoke", version: "1" }, capabilities: { experimentalApi: true } });
      peer.notify("initialized");
      const trusted = await peer.request("hooks/list", { cwd: root });
      assert(trusted.data.flatMap((entry) => entry.hooks).every((item) => item.trustStatus === "trusted"), JSON.stringify(trusted));
      const thread = await peer.request("thread/start", { cwd: root, model: "gpt-5", modelProvider: "offline" });
      assert(thread.thread.id);
      await peer.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "native sync smoke" }] });
      let events = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        events = await readFile(log, "utf8").catch(() => "");
        if (events.includes("Stop")) break;
        await delay(100);
      }
      assert(events.includes("SessionStart"), "Codex must execute the trusted SessionStart hook");
      assert(events.includes("UserPromptSubmit") && events.includes("Stop"), "Codex must execute prompt and Stop hooks");
      const { readNativeTranscript } = await import(pathToFileURL(join(cli, "dist", "runtime", "native-transcript.js")).href);
      let transcript;
      for (let attempt = 0; attempt < 30; attempt++) {
        transcript = await readNativeTranscript(thread.thread.path, "codex");
        if (transcript.turns.at(-1)?.result) break;
        await delay(100);
      }
      assert.equal(transcript.turns.at(-1)?.result?.status, "completed");
      assert(transcript.turns.at(-1)?.userContent.some((block) => block.type === "text" && block.text.includes("native sync smoke")));
      assert(transcript.turns.at(-1).result.messages.some((message) => message.content.some((block) => block.text === "fixture answer")));
      console.log("Codex hooks/trust/Turn transcript: passed (loopback fixture only)");
    } finally { await peer.close(); }
    assert((await readFile(log, "utf8")).includes("SessionEnd"), "Codex must run SessionEnd on shutdown");
  }
} finally { await new Promise((resolve) => modelServer.close(resolve)); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
