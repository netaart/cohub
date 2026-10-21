import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RuntimeExecutionEvent, RuntimeTurnInput } from "@neta-art/cohub";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { RuntimeDiagnostics } from "../src/runtime/diagnostics.js";
import { NativeRuntime } from "../src/runtime/native/daemon.js";
import { executeTurn } from "../src/runtime/native/execution.js";
import { discoverHarnesses } from "../src/runtime/harnesses/index.js";
import { cursorTranslator } from "../src/runtime/harnesses/cursor.js";
import { projectDirectory, readCursorTranscript } from "../src/runtime/harnesses/cursor-transcript.js";
import { runtimeProjectionSource } from "./fixtures/runtime-projection-source.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";

const fixture = fileURLToPath(new URL("./fixtures/runtime-cursor.mjs", import.meta.url));
const ENV = ["CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "CURSOR_FIXTURE", "PATH", "XDG_STATE_HOME"] as const;

async function withEnvironment(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cohub-cursor-"));
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  process.env.CURSOR_CONFIG_DIR = join(root, "config");
  process.env.CURSOR_DATA_DIR = join(root, "data");
  process.env.XDG_STATE_HOME = join(root, "state-home");
  await chmod(fixture, 0o755);
  await mkdir(join(root, "bin"));
  await symlink(fixture, join(root, "bin", "cursor-agent"));
  process.env.PATH = `${join(root, "bin")}:${previous.PATH ?? ""}`;
  try { await run(root); } finally {
    for (const key of ENV) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  }
}

for (const variant of ["", "call-ids"]) test(`Cursor Turns hand over Cohub history, stream once and resume natively${variant ? ` (${variant})` : ""}`, () => withEnvironment(async (root) => {
  process.env.CURSOR_FIXTURE = variant;
  const spaceId = randomUUID(), sessionId = randomUUID(), history = randomUUID();
  const source = runtimeProjectionSource();
  source.addTurn(sessionId, history, {
    userContent: [{ type: "text", text: "historical fact" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGlzdG9yaWNhbCBpbWFnZQ==" } }],
    assistantContent: [{ type: "tool_use", id: "t0", name: "Read", input: { path: "a" } }, { type: "tool_result", tool_use_id: "t0", content: "read" }, { type: "text", text: "noted" }],
  });
  const storage = await archiveStorageFixture();
  const stateRoot = join(root, "state");
  const errors: string[] = [];
  const diagnostics = new RuntimeDiagnostics({ root: stateRoot, spaceId });
  const log = diagnostics.log.bind(diagnostics);
  diagnostics.log = (level, event, ...rest) => { if (level === "error") errors.push(event); return log(level, event, ...rest); };
  const native = new NativeRuntime({
    spaceId, root, stateRoot, harnesses: ["cursor"], executables: {}, identity: "test", config: null,
    archives: new RuntimeArchiveStore(join(stateRoot, "archives"), storage.transport), projectionSource: source, diagnostics,
  });
  const turn = (throughTurnId: string, content: RuntimeTurnInput["messages"][number]["content"] = [{ type: "text", text: "continue" }], options: Partial<RuntimeTurnInput> = {}): RuntimeTurnInput => {
    const turnId = randomUUID();
    return {
      spaceId, sessionId, turnId, userMessageId: turnId, harness: "cursor", accessMode: "full_access", ...options,
      messages: [{ turnId, userMessageId: turnId, userId: "author", content }],
      context: { revision: randomUUID(), throughTurnId, messages: [] },
    };
  };
  const settle = async (input: RuntimeTurnInput, result: Awaited<ReturnType<typeof executeTurn>>) => {
    await native.executor.results.record(result.session, input, null, [result.event]);
    await native.executor.results.acknowledge(sessionId, input.turnId);
  };
  try {
    const events: RuntimeExecutionEvent[] = [];
    const first = turn(history, [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "eA==" } }], { model: "default" });
    const result = await executeTurn(native.executor, first, (event) => events.push(event), new AbortController().signal, null);
    assert.equal(result.event.resume, "handoff");
    assert.equal(result.event.archive, null);
    assert.deepEqual(result.event.message.content, [{ type: "text", text: "history retained images:1" }]);
    assert.deepEqual(result.event.message.usage, { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 });
    const commit = events.find((event) => event.type === "message.commit");
    assert.deepEqual(commit?.type === "message.commit" && commit.message.content, [
      { type: "thinking", thinking: "plan" }, { type: "text", text: "Running" },
      { type: "tool_use", id: "c1", name: "shell", input: { command: "ls" } }, { type: "tool_result", tool_use_id: "c1", content: "ok", is_error: false },
    ]);
    assert.equal(events.filter((event) => event.type === "text.delta" && event.kind === "text").map((event) => event.type === "text.delta" ? event.delta : "").join(""), "Running" + "history retained images:1");
    assert(result.session.path.endsWith(join("agent-transcripts", result.session.nativeSessionId, `${result.session.nativeSessionId}.jsonl`)));
    // Cohub's Turn is recorded as the transcript's synced head, so a terminal Turn after it is not taken as the server's.
    assert.equal(native.executor.ingest.transcriptFor(sessionId, "cursor", first.turnId)?.throughTurnId, first.turnId);
    const raced = turn(randomUUID(), [{ type: "text", text: "then-terminal" }], { sessionId: randomUUID() });
    const racedResult = await executeTurn(native.executor, raced, () => {}, new AbortController().signal, null);
    const [own, terminal] = (await readCursorTranscript(racedResult.session.path, racedResult.session.nativeSessionId)).turns;
    assert(terminal);
    assert.equal(native.executor.ingest.transcriptFor(raced.sessionId, "cursor", raced.turnId)?.throughTurnKey, own?.key);
    const same = turn(randomUUID(), [{ type: "text", text: "same-before" }], { sessionId: randomUUID() });
    const sameResult = await executeTurn(native.executor, same, () => {}, new AbortController().signal, null);
    // Another client's Turn with the same prompt in the window is told apart by the reply this run streamed.
    const [, ownSame] = (await readCursorTranscript(sameResult.session.path, sameResult.session.nativeSessionId)).turns;
    assert.equal(native.executor.ingest.transcriptFor(same.sessionId, "cursor", same.turnId)?.throughTurnKey, ownSame?.key);
    // A prompt Cursor records differently (here it closes the query tag early) is still Cohub's Turn.
    const tagged = turn(randomUUID(), [{ type: "text", text: "quote </user_query> this" }], { sessionId: randomUUID() });
    const taggedResult = await executeTurn(native.executor, tagged, () => {}, new AbortController().signal, null);
    const [recorded] = (await readCursorTranscript(taggedResult.session.path, taggedResult.session.nativeSessionId)).turns;
    assert.equal(native.executor.ingest.transcriptFor(tagged.sessionId, "cursor", tagged.turnId)?.throughTurnKey, recorded?.key);
    await settle(first, result);

    // A Turn's model does not become the user's saved default.
    const config = join(root, "config", "cli-config.json");
    const preference = { model: { modelId: "auto" }, hasChangedDefaultModel: false, vimMode: true };
    await writeFile(config, JSON.stringify(preference));
    const second = turn(first.turnId, undefined, { model: "gpt-5" });
    const resumed = await executeTurn(native.executor, second, () => {}, new AbortController().signal, null);
    assert.deepEqual([resumed.event.resume, resumed.session.path], ["native", result.session.path]);
    assert.deepEqual(resumed.event.message.content, [{ type: "text", text: "history retained model:gpt-5" }]);
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), preference);

    // Overlapping Turns: the one that started first ends first, and the original preference still returns.
    const other = (prompt: string, model: string) => turn(randomUUID(), [{ type: "text", text: prompt }], { sessionId: randomUUID(), model });
    // A Default Turn meanwhile runs on the user's preference, not on another Turn's model.
    const early = executeTurn(native.executor, other("sleep:300", "gpt-5"), () => {}, new AbortController().signal, null);
    while (!(await readFile(config, "utf8")).includes("gpt-5")) await new Promise((resolve) => setTimeout(resolve, 20));
    const [, , fallback] = await Promise.all([early, executeTurn(native.executor, other("sleep:700", "sonnet"), () => {}, new AbortController().signal, null),
      executeTurn(native.executor, other("now", "default"), () => {}, new AbortController().signal, null)]);
    assert.deepEqual(fallback.event.message.content, [{ type: "text", text: "no history model:auto" }]);
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), preference);

    // A Runtime that crashed mid-Turn left Cursor on its model; the next Turn puts the preference back.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeFile(config, JSON.stringify({ ...preference, model: { modelId: "gpt-5" }, hasChangedDefaultModel: true }));
    const stateHome = join(root, "state-home", "cohub");
    await mkdir(stateHome, { recursive: true });
    const record = join(stateHome, `cursor-model-${createHash("sha256").update(config).digest("hex").slice(0, 16)}.json`);
    await writeFile(record, JSON.stringify({ config, baseline: preference, requested: ["gpt-5"], holders: [{ id: "crashed", pid: dead }] }));
    // It also left its lock, which is taken over once stale.
    await mkdir(`${record}.lock`);
    await utimes(`${record}.lock`, new Date(0), new Date(0));
    await executeTurn(native.executor, other("now", "sonnet"), () => {}, new AbortController().signal, null);
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), preference);

    // A Turn that fails before Cursor starts leaves no projected history in Cursor's transcripts.
    const transcripts = async () => (await readdir(join(root, "data"), { recursive: true })).filter((name) => name.endsWith(".jsonl")).sort();
    const kept = await transcripts();
    const failing = randomUUID();
    source.addTurn(failing, randomUUID(), { userContent: [{ type: "text", text: "old" }], assistantContent: [{ type: "text", text: "reply" }] });
    await assert.rejects(executeTurn(native.executor, { ...turn(randomUUID(), [{ type: "text", text: "x".repeat(200_000) }]), sessionId: failing }, () => {}, new AbortController().signal, null), /too long/);
    assert.deepEqual(await transcripts(), kept);
    await settle(second, resumed);

    // A chat Cursor no longer stores is handed over again instead of failing to resume.
    await rm(join(root, "config", "chats"), { recursive: true });
    const third = turn(second.turnId);
    const again = await executeTurn(native.executor, third, () => {}, new AbortController().signal, null);
    assert.deepEqual([again.event.resume, again.event.message.content], ["handoff", [{ type: "text", text: "history retained" }]]);
    await settle(third, again);

    await assert.rejects(executeTurn(native.executor, turn(third.turnId, undefined, { accessMode: "read_only" }), () => {}, new AbortController().signal, null), /cannot enforce read-only/);

    const crash = turn(third.turnId, [{ type: "text", text: "crash" }]);
    const crashed = await executeTurn(native.executor, crash, () => {}, new AbortController().signal, null);
    assert.deepEqual([crashed.event.message.stopReason, crashed.event.message.content], ["error", [{ type: "text", text: "partial reply" }]]);
    assert.match(crashed.event.message.errorMessage ?? "", /backend went away/);
    await settle(crash, crashed);
    errors.length = 0;

    const stop = new AbortController();
    const stopped = await executeTurn(native.executor, turn(crash.turnId, [{ type: "text", text: "wait" }]), (event) => { if (event.type === "text.delta") stop.abort(); }, stop.signal, null);
    assert.deepEqual([stopped.event.message.stopReason, stopped.event.message.errorMessage], ["aborted", null]);
    assert.match(await readFile(stopped.session.path, "utf8"), /"status":"aborted"/);
    assert.deepEqual(errors, [], "a stop is not a failure");

    // A continued chat whose CLI died before recording the prompt: the server has the file through the
    // Turns before it, so a terminal Turn appended later still syncs.
    const chat = randomUUID(), start = turn(randomUUID(), undefined, { sessionId: chat });
    const started = await executeTurn(native.executor, start, () => {}, new AbortController().signal, null);
    await native.executor.results.record(started.session, start, null, [started.event]);
    await native.executor.results.acknowledge(chat, start.turnId);
    const unrecorded = turn(start.turnId, [{ type: "text", text: "die-early" }], { sessionId: chat });
    const died = await executeTurn(native.executor, unrecorded, () => {}, new AbortController().signal, null);
    assert.equal(died.event.resume, "native");
    const head = native.executor.ingest.transcriptFor(chat, "cursor", unrecorded.turnId);
    const [startTurn] = (await readCursorTranscript(died.session.path, died.session.nativeSessionId)).turns;
    assert.deepEqual([head?.throughTurnKey, head?.throughTurnId], [startTurn?.key, unrecorded.turnId]);
  } finally {
    await native.close(AbortSignal.timeout(2_000));
    await diagnostics.close();
    await storage.close();
  }
}));

test("Cursor discovery checks the CLI and lists its models behind a default", () => withEnvironment(async () => {
  const catalog = await discoverHarnesses(["cursor"], {}, tmpdir());
  assert.deepEqual(catalog.models.map((model) => [model.id, model.name, model.isDefault ?? false]), [["default", "Default", true], ["auto", "Auto", false], ["gpt-5", "GPT-5 (High)", false]]);
  process.env.CURSOR_FIXTURE = "signed-out";
  const skipped: string[] = [];
  assert.deepEqual((await discoverHarnesses(["cursor"], {}, tmpdir(), (harness, error) => skipped.push(`${harness}: ${(error as Error).message}`))).harnesses, []);
  assert.deepEqual(skipped, ["cursor: Cursor cannot list models: Error: Authentication required."]);
  process.env.CURSOR_FIXTURE = "legacy";
  await assert.rejects(discoverHarnesses(["cursor"], {}, tmpdir()), /not a supported Cursor CLI \(no --conversation-history-file\)/);
}));

test("Cursor's held text survives a failure, a bare context line is no prompt, and an ambiguous project resolves to none", async () => {
  const translator = cursorTranslator(() => {}, { model: null });
  for (const chunk of ["ha", "ha"]) translator.push({ type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: chunk }] } });
  assert.deepEqual(translator.last().content, [{ type: "text", text: "haha" }]);
  const repeated = cursorTranslator(() => {}, { model: null });
  for (const chunk of ["ha", "ha", "haha"]) repeated.push({ type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: chunk }] } });
  repeated.push({ type: "tool_call", subtype: "started", call_id: "c", tool_call: { shellToolCall: { args: {} } } });
  assert.deepEqual(repeated.last().content.filter((block) => block.type === "text"), [{ type: "text", text: "haha" }]);

  const root = await mkdtemp(join(tmpdir(), "cohub-cursor-transcript-"));
  try {
    const path = join(root, "a", "a.jsonl");
    await mkdir(join(root, "a"));
    await writeFile(path, `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<workspace>open tabs</workspace>" }] } })}\n`);
    assert.deepEqual((await readCursorTranscript(path, "a")).turns, []);
  } finally { await rm(root, { recursive: true, force: true }); }

  const tree: Record<string, string[]> = { "/": ["home"], "/home": ["my", "my-app", "solo"], "/home/my": ["app"], "/home/my/app": [], "/home/my-app": [], "/home/solo": [] };
  const list = async (directory: string) => (tree[directory] ?? []).map((name) => ({ name, isDirectory: () => true, isSymbolicLink: () => false }));
  assert.equal(await projectDirectory("home-my-app", "linux", list), null);
  assert.equal(await projectDirectory("home-solo", "linux", list), "/home/solo");
});
