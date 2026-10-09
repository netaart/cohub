// Real-harness smoke for the native Runtime: real Pi and Codex binaries, isolated homes and a
// deterministic loopback model. No credentials, no external model calls, nothing outside a temp dir.
//
//   COHUB_NATIVE_PI_BIN=$(which pi) COHUB_NATIVE_CODEX_BIN=/path/to/codex pnpm test:runtime:native
//
// Covered: a Cohub Turn in a Pi that Cohub starts; a terminal Pi syncing through the ledger with a
// live preview; a web prompt and a web stop reaching that terminal Pi through its extension, which
// follows the terminal to a new session; the same
// through Codex's shared app-server with a second client standing in for the terminal; and the
// private app-server fallback.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import WebSocket from "ws";

const piBinary = process.env.COHUB_NATIVE_PI_BIN;
const codexBinary = process.env.COHUB_NATIVE_CODEX_BIN;
if (!piBinary && !codexBinary) throw new Error("Set COHUB_NATIVE_PI_BIN and/or COHUB_NATIVE_CODEX_BIN");

const home = await mkdtemp(join(tmpdir(), "cohub-native-smoke-"));
const project = join(home, "project");
await mkdir(project, { recursive: true });
for (const key of Object.keys(process.env)) if (key.startsWith("COHUB_") && !key.startsWith("COHUB_NATIVE_")) delete process.env[key];
Object.assign(process.env, {
  HOME: home, XDG_STATE_HOME: join(home, "state"), PI_CODING_AGENT_DIR: join(home, "pi"), CODEX_HOME: join(home, "codex"),
  PI_OFFLINE: "1", OTEL_SDK_DISABLED: "true",
});
delete process.env.PI_CODING_AGENT_SESSION_DIR;

// Imported after the environment is isolated: some paths are resolved at module load.
const { NativeRuntime } = await import("../src/runtime/native/daemon.js");
const { executeTurn } = await import("../src/runtime/native/execution.js");
const { installPiExtension } = await import("../src/runtime/native/install.js");
const { RuntimeArchiveStore } = await import("../src/runtime/archive-store.js");
const { RuntimeDiagnostics } = await import("../src/runtime/diagnostics.js");
const { runtimeProjectionSource } = await import("./fixtures/runtime-projection-source.js");
const { fakeNativeServer } = await import("./fixtures/native-server.js");

/** Responses API stream. A prompt containing "slow" streams for half a minute unless stopped. */
const model = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (request.method !== "POST") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":[]}'); return; }
  const request_ = JSON.parse(body) as { input?: Array<{ role?: string; type?: string; output?: unknown }>; tools?: Array<{ name?: string }> };
  const input = request_.input ?? [];
  const lastUser = JSON.stringify(input.filter((item) => item.role === "user").at(-1) ?? "");
  const slow = /slow/.test(lastUser);
  const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  let closed = false;
  response.on("close", () => { closed = true; });
  response.writeHead(200, { "content-type": "text/event-stream" });
  const last = input.at(-1);
  // "envcheck" asks the harness to run a shell command that prints what its tools see.
  if (/envcheck/.test(lastUser) && last?.type !== "function_call_output") {
    // A real model takes a moment before its first tool call; the Runtime's context lands meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const bash = request_.tools?.some((tool) => tool.name === "bash");
    const command = "echo turn=$COHUB_TURN_ID session=$COHUB_SESSION_ID";
    const call = { id: "fc_1", type: "function_call", call_id: `call_${Date.now()}`, name: bash ? "bash" : "exec_command", arguments: JSON.stringify(bash ? { command } : { cmd: command }) };
    send({ type: "response.created", response: { id: "resp_fc", status: "in_progress", output: [] } });
    send({ type: "response.output_item.added", output_index: 0, item: call });
    send({ type: "response.output_item.done", output_index: 0, item: call });
    send({ type: "response.completed", response: { id: "resp_fc", status: "completed", output: [call], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } });
    response.end();
    return;
  }
  const answer = last?.type === "function_call_output" ? `TOOL_OUTPUT:${typeof last.output === "string" ? last.output : JSON.stringify(last.output)}` : null;
  const item = { id: `msg_${Date.now()}`, type: "message", role: "assistant", content: [{ type: "output_text", text: "", annotations: [] }] };
  send({ type: "response.created", response: { id: "resp", status: "in_progress", output: [] } });
  send({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
  send({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  let text = "";
  for (const delta of answer ? [answer] : slow ? Array.from({ length: 60 }, (_, index) => `tick${index} `) : ["fixture ", "answer"]) {
    if (closed) return;
    text += delta;
    send({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta });
    await new Promise((resolve) => setTimeout(resolve, slow ? 500 : 10));
  }
  const done = { ...item, content: [{ type: "output_text", text, annotations: [] }] };
  send({ type: "response.output_item.done", output_index: 0, item: done });
  send({ type: "response.completed", response: { id: "resp", status: "completed", output: [done], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } });
  response.end();
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;

const until = async (label: string, check: () => boolean | Promise<boolean>, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
/** The parts of Pi and Codex session records this test looks at. */
type Row = { type?: string; customType?: string; data?: { turnId?: string }; message?: { stopReason?: string }; payload?: { type?: string; item?: { client_id?: string } } };
const readRows = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Row);
const text = (content: Array<{ type: string; text?: string }>) => content.filter((block) => block.type === "text").map((block) => block.text).join("");
const turn = (harness: "pi" | "codex", prompt: string, options: Partial<RuntimeTurnInput> = {}): RuntimeTurnInput => {
  const turnId = crypto.randomUUID();
  return {
    spaceId: "space", sessionId: crypto.randomUUID(), turnId, userMessageId: turnId, harness, accessMode: "full_access",
    messages: [{ turnId, userMessageId: turnId, userId: "web", content: [{ type: "text", text: prompt }] }],
    context: { complete: true, revision: "r", throughTurnId: null, messages: [] },
    ...(harness === "pi" ? { provider: "cohub-fixture", model: "fixture" } : {}),
    ...options,
  };
};

type NativeRuntimeInstance = InstanceType<typeof NativeRuntime>;
type FakeServer = ReturnType<typeof fakeNativeServer>;

/**
 * Run a Cohub Turn as the server dispatches one: the server records it before the Runtime runs it,
 * so its marker in the native file is recognized rather than ingested again.
 */
async function dispatch(native: NativeRuntimeInstance, server: FakeServer, input: RuntimeTurnInput, requestId: string, parentTurnId: string | null = null) {
  server.turns.set(input.turnId, { sessionId: input.sessionId, settled: false, parentTurnId });
  const result = await executeTurn(native.executor, input, () => {}, AbortSignal.timeout(60_000), requestId);
  server.turns.set(input.turnId, { sessionId: input.sessionId, settled: true, parentTurnId });
  return result;
}

async function runtime(harness: "pi" | "codex", codexShared = false) {
  const stateRoot = join(home, `runtime-${harness}-${codexShared ? "shared" : "private"}`);
  const diagnostics = new RuntimeDiagnostics({ root: stateRoot, spaceId: "space" });
  const server = fakeNativeServer();
  const native = new NativeRuntime({
    spaceId: "space", root: project, stateRoot, harnesses: [harness], executables: { pi: piBinary, codex: codexBinary }, identity: "smoke",
    config: { version: 2, identity: "smoke", spaceId: "space", root: project, harnesses: [harness], enabledAt: new Date().toISOString(), codexShared },
    archives: new RuntimeArchiveStore(join(stateRoot, "archives"), null), projectionSource: runtimeProjectionSource(), diagnostics,
  });
  const controller = new AbortController();
  await native.start(controller.signal);
  native.connect(server.send);
  return { native, server, close: async () => { controller.abort(); await native.close(AbortSignal.timeout(5_000)); await diagnostics.close(); } };
}

type Terminal = { request(method: string, params?: Record<string, unknown>): Promise<unknown>; close(): void };

/** A user at a terminal Pi: its RPC mode, with the user's extensions loaded like the TUI. */
function piTerminal(binary: string): Terminal {
  const child = spawn(binary, ["--mode", "rpc", "--model", "cohub-fixture/fixture"], { cwd: project, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<string, (value: unknown) => void>();
  let buffer = "", sequence = 0;
  child.stdout.on("data", (bytes: Buffer) => {
    buffer += bytes.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.type === "response" && pending.has(String(message.id))) { pending.get(String(message.id))?.(message); pending.delete(String(message.id)); }
    }
  });
  return {
    request: (type, params = {}) => new Promise((resolve) => {
      const id = `t${++sequence}`;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ ...params, id, type })}\n`);
    }),
    close: () => { child.kill("SIGTERM"); },
  };
}

/** A user at a terminal Codex: another client of the shared app-server, as the TUI attaches. */
async function codexTerminal(): Promise<Terminal> {
  const socket = new WebSocket(`ws+unix://${join(home, "codex", "app-server-control", "app-server-control.sock")}:/`);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const pending = new Map<string, (value: unknown) => void>();
  let sequence = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.id != null && pending.has(String(message.id))) { pending.get(String(message.id))?.(message); pending.delete(String(message.id)); }
  });
  const terminal: Terminal = {
    request: (method, params = {}) => new Promise((resolve) => {
      const id = `t${++sequence}`;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    }),
    close: () => socket.close(),
  };
  await terminal.request("initialize", { clientInfo: { name: "smoke-terminal", title: "Smoke", version: "1" }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  return terminal;
}

try {
  if (piBinary) {
    await mkdir(join(home, "pi", "extensions"), { recursive: true });
    await writeFile(join(home, "pi", "extensions", "fixture-provider.ts"), `export default (pi: { registerProvider(name: string, config: unknown): void }) => pi.registerProvider("cohub-fixture", { baseUrl: ${JSON.stringify(modelUrl)}, api: "openai-responses", apiKey: "fixture", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });\n`);
    await installPiExtension();
    const { native, server, close } = await runtime("pi");
    try {
      const { executor } = native;
      // 1. A Cohub Turn in a Pi that Cohub starts: the extension drives it and marks the file.
      const first = turn("pi", "hello from the web");
      const result = await dispatch(native, server, first, "pi-1");
      assert.match(text(result.event.message.content), /fixture answer/);
      const rows = await readRows(result.session.path);
      assert(rows.some((row) => row.type === "custom" && row.customType === "cohub.turn" && row.data?.turnId === first.turnId), "Pi recorded the Cohub marker");
      console.log("pi: Cohub Turn in a Cohub-started Pi ✓");

      // 2. A terminal Pi syncs through the ledger, with a live preview while it runs.
      const tui = piTerminal(piBinary);
      await until("terminal Pi connects", () => native.status().pi?.connected === 1);
      await tui.request("prompt", { message: "hello from the terminal" });
      // Only the terminal's Turn is ingested; the Cohub Turn above is recognized by its marker.
      await until("terminal Turn is recorded", () => server.batches.some((batch) => batch.turns.some((entry) => entry.result)));
      assert(!server.batches.some((batch) => batch.turns.some((entry) => entry.turnId === first.turnId)), "a Cohub Turn is never ingested again");
      const sessionFile = executor.pi.list()[0]?.sessionFile as string;
      const terminalTurnId = server.batches[0]?.turns[0]?.turnId as string;
      const sessionId = server.turns.get(terminalTurnId)?.sessionId as string;
      console.log("pi: terminal Turn synced ✓");

      // 3. A web prompt continues the terminal's own session through its extension.
      const web = turn("pi", "hello again from the web", { sessionId, context: { complete: true, revision: "r", throughTurnId: terminalTurnId, messages: [] } });
      const continued = await dispatch(native, server, web, "pi-2", terminalTurnId);
      assert.equal(continued.event.resume, "native");
      assert.equal(continued.session.path, sessionFile, "the terminal's file, not a copy");
      assert((await readRows(sessionFile)).some((row) => row.data?.turnId === web.turnId));
      console.log("pi: web prompt reached the terminal session ✓");

      // 3b. Tools in the long-lived terminal Pi see the Space, Session and Turn they work for,
      //     both for a Turn the web sends and for one the terminal user runs.
      const webEnv = turn("pi", "envcheck from the web", { sessionId, context: { complete: true, revision: "r", throughTurnId: web.turnId, settledTurnIds: [web.turnId], messages: [] } });
      const webResult = await dispatch(native, server, webEnv, "pi-3", web.turnId);
      assert.match(text(webResult.event.message.content), new RegExp(`turn=${webEnv.turnId} session=${sessionId}`));
      const settledBefore = [...server.turns.values()].filter((entry) => entry.settled).length;
      await tui.request("prompt", { message: "envcheck from the terminal" });
      await until("terminal envcheck Turn is recorded", () => [...server.turns.values()].filter((entry) => entry.settled).length > settledBefore);
      const terminalEnvTurn = server.batches.flatMap((batch) => batch.turns).filter((entry) => entry.result).at(-1);
      const toolOutput = JSON.stringify(terminalEnvTurn?.result?.messages);
      assert.match(toolOutput, new RegExp(`turn=${terminalEnvTurn?.turnId} session=${sessionId}`), "the terminal Turn's own id reaches its tools");
      console.log("pi: tools know their Turn, from the web and from the terminal ✓");

      // 4. The web's stop reaches a terminal Turn; Pi records it as aborted.
      await tui.request("prompt", { message: "a slow terminal task" });
      await until("running terminal Turn", () => [...server.turns.values()].some((entry) => !entry.settled));
      await until("live preview", () => server.progress.length > 0);
      const running = [...server.turns.entries()].find(([, entry]) => !entry.settled)?.[0] as string;
      assert(native.stop(sessionId, running), "the web's stop reaches the Runtime as a push");
      await until("stop recorded", async () => (await readRows(sessionFile)).some((row) => row.message?.stopReason === "aborted"));
      console.log("pi: web stop reached the terminal Turn ✓");

      // 4b. Pi replaces its extension on a session switch; the new session connects in place of the old.
      const previous = executor.pi.list()[0]?.sessionId;
      await tui.request("new_session");
      await until("the new session connects", () => executor.pi.list().length === 1 && executor.pi.list()[0]?.sessionId !== previous);
      console.log("pi: a session switch reconnects as the new session ✓");
      tui.close();
    } finally { await close(); }
  }

  if (codexBinary) {
    await mkdir(join(home, "codex"), { recursive: true });
    await writeFile(join(home, "codex", "config.toml"), [
      // The user's own policy applies to Cohub's Turns; this container cannot nest a sandbox.
      'model = "gpt-5"', 'model_provider = "offline"', 'sandbox_mode = "danger-full-access"', 'approval_policy = "never"', "[features]", "plugins = false", "recommended_plugins = false",
      "[model_providers.offline]", 'name = "Offline fixture"', `base_url = ${JSON.stringify(modelUrl)}`, 'wire_api = "responses"', "requires_openai_auth = false",
      `[projects.${JSON.stringify(project)}]`, 'trust_level = "trusted"', "",
    ].join("\n"));
    // 5. Without the shared server, Cohub Turns run on a private one.
    {
      const { native, server, close } = await runtime("codex", false);
      try {
        const result = await dispatch(native, server, turn("codex", "hello privately"), "codex-private");
        assert.match(text(result.event.message.content), /fixture answer/);
        console.log("codex: private app-server fallback ✓");
      } finally { await close(); }
    }
    const { native, server, close } = await runtime("codex", true);
    try {
      // 6. A Cohub Turn through the shared app-server, tagged with its cloud Turn id.
      const first = turn("codex", "hello from the web");
      const result = await dispatch(native, server, first, "codex-1");
      assert.match(text(result.event.message.content), /fixture answer/);
      assert.equal(native.status().codex?.control, "shared");
      const rows = await readRows(result.session.path);
      assert(rows.some((row) => row.payload?.item?.client_id === first.turnId), "the rollout records the Cohub Turn id");
      console.log("codex: Cohub Turn on the shared app-server ✓");
      const envcheck = turn("codex", "envcheck", { sessionId: first.sessionId, context: { complete: true, revision: "r", throughTurnId: first.turnId, settledTurnIds: [first.turnId], messages: [] } });
      const envResult = await dispatch(native, server, envcheck, "codex-env", first.turnId);
      assert.match(JSON.stringify(envResult.event.message.content) + JSON.stringify(await readRows(result.session.path)), new RegExp(`session=${first.sessionId}`), "shared-server tools see their Session");
      console.log("codex: tools on the shared server see their Session ✓");

      // 7. Another client of the same server (the terminal) continues the thread; the Turn syncs
      //    as a continuation of the Cohub Turn.
      const tui = await codexTerminal();
      await tui.request("thread/resume", { threadId: result.session.nativeSessionId });
      await tui.request("turn/start", { threadId: result.session.nativeSessionId, input: [{ type: "text", text: "hello from the terminal", text_elements: [] }] });
      await until("terminal Turn is recorded", () => [...server.turns.values()].some((entry) => entry.settled && entry.parentTurnId === first.turnId));
      console.log("codex: terminal Turn synced as a continuation ✓");

      // 8. The web's stop interrupts a Turn the terminal runs.
      await tui.request("turn/start", { threadId: result.session.nativeSessionId, input: [{ type: "text", text: "a slow terminal task", text_elements: [] }] });
      await until("running terminal Turn", () => [...server.turns.values()].some((entry) => !entry.settled));
      const running = [...server.turns.entries()].find(([, entry]) => !entry.settled)?.[0] as string;
      assert.equal(server.batches.flatMap((batch) => batch.turns).find((entry) => entry.turnId === running)?.controllable, true);
      await until("terminal Turn streams token by token", () => server.progress.filter((entry) => entry.turnId === running).length >= 3);
      console.log("codex: terminal Turn streamed live ✓");
      assert(native.stop(first.sessionId, running), "the web's stop reaches the Runtime as a push");
      await until("stop recorded", async () => (await readRows(result.session.path)).some((row) => row.payload?.type === "turn_aborted"));
      console.log("codex: web stop interrupted the terminal Turn ✓");

      // 9. A thread the terminal starts on its own is found through the server's status broadcast.
      const started = await tui.request("thread/start", { cwd: project }) as { result?: { thread?: { id?: string } } };
      const threadId = started.result?.thread?.id as string;
      const before = server.progress.length;
      await tui.request("turn/start", { threadId, input: [{ type: "text", text: "a slow task in a new thread", text_elements: [] }] });
      await until("new terminal thread streams live", () => server.progress.length >= before + 3);
      assert.equal(native.status().codex?.watching, 2);
      console.log("codex: a thread the terminal started streams live ✓");
      tui.close();
    } finally {
      await close();
      await promisify(execFile)(codexBinary, ["app-server", "daemon", "stop"], { env: process.env }).catch(() => undefined);
      // The daemon's updater loop outlives `stop`; it runs from the isolated home, so match on that.
      const { stdout } = await promisify(execFile)("pgrep", ["-f", join(home, "codex", "packages")]).catch(() => ({ stdout: "" }));
      for (const pid of stdout.split("\n").map(Number).filter((pid) => pid && pid !== process.pid)) { try { process.kill(pid); } catch { /* Already gone. */ } }
    }
  }
  console.log("native Runtime smoke passed");
} finally {
  model.close();
  // Leave nothing running; the isolated home is removed with everything in it.
  await rm(home, { recursive: true, force: true }).catch(async () => { await readdir(home).catch(() => []); });
}
