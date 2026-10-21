import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { claudeProjectName } from "../src/runtime/harnesses/claude.js";
import { piSessionDirectoryName } from "../src/runtime/harnesses/pi.js";
import { workbuddyProjectName } from "../src/runtime/harnesses/workbuddy.js";
import { cursorChatDirectory, cursorTranscriptPath } from "../src/runtime/harnesses/cursor-transcript.js";
import { nativeTurnId } from "../src/runtime/native/identity.js";
import { discoverTranscripts, NativeIngest, type IngestHooks, type TranscriptState } from "../src/runtime/native/ingest.js";
import { SizeLimitError } from "../src/runtime/native/transcript.js";
import { fakeNativeServer as fakeServer } from "./fixtures/native-server.js";

const at = "2026-01-01T00:00:00.000Z";
const SPACE = "00000000-0000-4000-8000-000000000001";
type Synced = "pi" | "codex" | "claude" | "workbuddy" | "cursor";
const turnIdOf = (harness: Synced, nativeSessionId: string, key: string) => nativeTurnId(SPACE, harness, nativeSessionId, key);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const piHeader = (id: string, cwd: string) => line({ type: "session", version: 3, id, cwd, timestamp: at });
const piMessage = (id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "message", id, parentId, timestamp: at, message: { role, content, ...extra } });
const piTurn = (n: number, parent: string | null) =>
  piMessage(`u${n}`, parent, "user", `question ${n}`) + piMessage(`a${n}`, `u${n}`, "assistant", [{ type: "text", text: `answer ${n}` }], { stopReason: "stop" });
const codexLine = (payload: Record<string, unknown>, type = "event_msg") => line({ timestamp: at, type, payload });
const codexRollout = (id: string, cwd: string, turns: string[], extra: Record<string, unknown> = {}) => [
  line({ timestamp: at, type: "session_meta", payload: { id, cwd, ...extra } }),
  ...turns.flatMap((key) => [
    line({ timestamp: at, type: "event_msg", payload: { type: "turn_started", turn_id: key } }),
    line({ timestamp: at, type: "event_msg", payload: { type: "user_message", message: `q ${key}` } }),
    line({ timestamp: at, type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } }),
  ]),
].join("");
const claudeRecord = (sessionId: string, cwd: string, value: Record<string, unknown>) => line({ isSidechain: false, cwd, sessionId, timestamp: at, ...value });
/** A Claude Code Turn: prompt, reply, and in interactive sessions the recorded end. */
const claudeTurn = (sessionId: string, cwd: string, uuid: string, parentUuid: string | null, prompt: string, ended = true) =>
  claudeRecord(sessionId, cwd, { type: "user", uuid, parentUuid, promptId: `p-${uuid}`, promptSource: "typed", message: { role: "user", content: prompt } })
  + claudeRecord(sessionId, cwd, { type: "assistant", uuid: `a-${uuid}`, parentUuid: uuid, message: { id: `m-${uuid}`, role: "assistant", model: "claude-test", content: [{ type: "text", text: `re ${prompt}` }], stop_reason: "end_turn" } })
  + (ended ? claudeRecord(sessionId, cwd, { type: "system", subtype: "turn_duration", uuid: `d-${uuid}`, parentUuid: `a-${uuid}` }) : "");
const workbuddyTurn = (sessionId: string, cwd: string, id: string, parentId: string | null, prompt: string) =>
  line({ id, ...(parentId ? { parentId } : {}), timestamp: 1, type: "message", role: "user", content: [{ type: "input_text", text: prompt }], sessionId, cwd })
  + line({ id: `a-${id}`, parentId: id, timestamp: 2, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `re ${prompt}` }], providerData: { messageId: `m-${id}`, model: "hy-test" }, sessionId, cwd });

/** A Cursor Turn: context, the prompt, a reply step and the recorded end. */
const cursorPrompt = (prompt: string) => line({ role: "user", message: { content: [{ type: "text", text: "<workspace>open tabs</workspace>" }] } })
  + line({ role: "user", message: { content: [{ type: "text", text: `<timestamp>Saturday, Aug 01, 2026, 9:30 AM (UTC+8)</timestamp>\n<user_query>${prompt}</user_query>` }] } });
const cursorTurn = (prompt: string) => cursorPrompt(prompt)
  + line({ role: "assistant", message: { content: [{ type: "text", text: `re ${prompt}` }, { type: "tool_use", name: "Shell", input: { command: "ls" } }] } })
  + line({ type: "turn_ended", status: "success" });
/** A Cursor Turn is keyed by the file's checksum through its prompt. */
const cursorKey = (before: string) => createHash("sha256").update(before).digest("hex");

async function until(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for ingest");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "cohub-ingest-"));
  const project = join(root, "project");
  await mkdir(join(project, "sub"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.CODEX_HOME = join(root, "codex-home");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CODEBUDDY_CONFIG_DIR = join(root, "codebuddy");
  process.env.CURSOR_CONFIG_DIR = join(root, "cursor-config");
  process.env.CURSOR_DATA_DIR = join(root, "cursor-data");
  const piDirectory = (cwd: string) => join(root, "pi-agent", "sessions", piSessionDirectoryName(cwd));
  const codexPath = (id: string) => join(root, "codex-home", "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  const claudePath = (cwd: string, id: string) => join(root, "claude", "projects", claudeProjectName(cwd), `${id}.jsonl`);
  const workbuddyPath = (cwd: string, id: string) => join(root, "codebuddy", "projects", workbuddyProjectName(cwd), `${id}.jsonl`);
  const ingest = (options: { enabledAt?: string; harnesses?: Synced[]; hooks?: IngestHooks } = {}) => new NativeIngest({
    spaceId: SPACE, cwd: project, harnesses: options.harnesses ?? ["pi", "codex"], enabledAt: options.enabledAt ?? new Date(0).toISOString(),
    root: join(root, "state"), archives: new RuntimeArchiveStore(join(root, "state", "archives"), null), hooks: options.hooks,
  });
  const write = async (path: string, content: string, mtime?: Date) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    if (mtime) await utimes(path, mtime, mtime);
  };
  return { root, project, piDirectory, codexPath, claudePath, workbuddyPath, ingest, write, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("discovery covers the project and its subdirectories, skips Codex's own threads, newest first", async () => {
  const w = await workspace();
  try {
    const old = new Date("2025-01-01T00:00:00Z"), recent = new Date("2025-06-01T00:00:00Z");
    await w.write(join(w.piDirectory(w.project), "a.jsonl"), piHeader(randomUUID(), w.project) + piTurn(1, null), old);
    await w.write(join(w.piDirectory(join(w.project, "sub")), "b.jsonl"), piHeader(randomUUID(), join(w.project, "sub")) + piTurn(1, null), recent);
    // A sibling whose encoded folder shares the prefix is pruned by its header, not by name.
    await w.write(join(w.piDirectory(`${w.project}-other`), "c.jsonl"), piHeader(randomUUID(), `${w.project}-other`) + piTurn(1, null));
    const user = randomUUID(), internal = randomUUID(), spawned = randomUUID(), foreign = randomUUID();
    await w.write(w.codexPath(user), codexRollout(user, w.project, ["t1"]));
    await w.write(w.codexPath(internal), codexRollout(internal, w.project, ["t2"], { source: { subagent: "compact" } }));
    await w.write(w.codexPath(spawned), codexRollout(spawned, w.project, ["t3"], { source: { subagent: { thread_spawn: {} } } }));
    await w.write(w.codexPath(foreign), codexRollout(foreign, w.root, ["t4"]));
    const found = await discoverTranscripts(w.project, ["pi", "codex"], { headers: true });
    assert.deepEqual(found.map((item) => item.nativeSessionId ?? item.path).length, 3);
    assert(found.some((item) => item.nativeSessionId === user));
    assert.deepEqual(found.filter((item) => item.harness === "pi").map((item) => item.path.endsWith("b.jsonl")), [true, false], "newest first");
  } finally { await w.cleanup(); }
});

test("native scan and import sync root and child sessions while excluding nested bindings", async () => {
  const w = await workspace();
  const ingest = w.ingest({ enabledAt: "2026-01-01T00:00:00Z", harnesses: ["codex"] });
  try {
    const server = fakeServer();
    const child = join(w.project, "sub");
    const nested = join(child, "nested");
    ingest.exclude([`${w.project}/.`, w.project.toUpperCase(), nested]);
    const live = randomUUID(), history = randomUUID(), excluded = randomUUID(), sibling = randomUUID();
    const recent = new Date("2026-01-02T00:00:00Z");
    await w.write(w.codexPath(live), codexRollout(live, w.project, ["live"]), recent);
    await w.write(w.codexPath(history), codexRollout(history, child, ["history"]), new Date("2025-01-01T00:00:00Z"));
    await w.write(w.codexPath(excluded), codexRollout(excluded, join(nested, "child"), ["excluded"]), recent);
    await w.write(w.codexPath(sibling), codexRollout(sibling, `${w.project}-other`, ["sibling"]), recent);
    await ingest.load();
    ingest.connect(server.transport);
    await until(() => server.turns.has(turnIdOf("codex", live, "live")) && ingest.status().live === 0);
    assert.equal(server.turns.size, 1);
    assert.deepEqual((await ingest.plan()).map((item) => item.nativeSessionId), [history]);
    await ingest.startImport();
    await until(() => ingest.status().import.state === "done");
    assert.equal(server.turns.size, 2);
    assert(server.turns.has(turnIdOf("codex", history, "history")));
  } finally { await ingest.close(AbortSignal.timeout(2_000)); await w.cleanup(); }
});

test("a new terminal conversation syncs in order, and a restart asks the server instead of resending", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const id = randomUUID();
    const path = join(w.piDirectory(w.project), "live.jsonl");
    await w.write(path, piHeader(id, w.project) + piTurn(1, null) + piTurn(2, "a1"));
    // Pi's last Turn counts as ended once the transcript has been quiet for a while.
    await utimes(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const ingest = w.ingest();
    await ingest.load();
    ingest.connect(server.transport);
    await until(() => server.turns.size === 2);
    const first = turnIdOf("pi", id, "u1"), second = turnIdOf("pi", id, "u2");
    assert.equal(server.turns.get(second)?.parentTurnId, first);
    assert.equal(server.turns.get(first)?.sessionId, server.turns.get(second)?.sessionId);
    assert.equal(server.turns.get(first)?.origin, undefined, "Turns after sync started are not imports");
    await ingest.close(AbortSignal.timeout(2_000));

    await appendFile(path, piTurn(3, "a2"));
    await utimes(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const batches = server.batches.length;
    const restarted = w.ingest();
    await restarted.load();
    restarted.connect(server.transport);
    await until(() => server.turns.size === 3);
    assert.equal(server.batches.length, batches + 1, "only the new Turn is sent");
    assert.deepEqual(server.batches.at(-1)?.turns.map((turn) => turn.turnId), [turnIdOf("pi", id, "u3")]);
    await restarted.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("a Turn over a size limit is not resent until its transcript changes", async () => {
  const w = await workspace();
  const server = fakeServer();
  let attempts = 0;
  const transport = { ...server.transport, ingest: async () => { attempts += 1; throw new SizeLimitError("Runtime frame exceeds transfer limit"); } };
  const ingest = w.ingest({ hooks: { onError: () => {} } });
  try {
    const id = randomUUID();
    const path = join(w.piDirectory(w.project), "big.jsonl");
    const quiet = new Date(Date.now() - 60_000);
    await w.write(path, piHeader(id, w.project) + piTurn(1, null), quiet);
    await ingest.load();
    ingest.connect(transport);
    await until(() => attempts === 1);
    // A reconnect and a backoff window would both have retried the same bytes.
    ingest.connect(transport);
    ingest.touch(path);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(attempts, 1);
    await appendFile(path, piTurn(2, "a1"));
    await utimes(path, quiet, new Date(quiet.getTime() + 1_000));
    ingest.touch(path);
    await until(() => attempts === 2);
  } finally { await ingest.close(AbortSignal.timeout(2_000)); await w.cleanup(); }
});

test("an automatically resumed import skips a size-limited history file; an explicit import retries it", async () => {
  const w = await workspace();
  const server = fakeServer();
  let attempts = 0;
  const transport = { ...server.transport, ingest: async () => { attempts += 1; throw new SizeLimitError("Runtime frame exceeds transfer limit"); } };
  const ingest = w.ingest({ enabledAt: "2026-01-01T00:00:00Z", hooks: { onError: () => {} } });
  try {
    const id = randomUUID();
    const path = join(w.piDirectory(w.project), "history.jsonl");
    await w.write(path, piHeader(id, w.project) + piTurn(1, null), new Date("2025-01-01T00:00:00Z"));
    await ingest.load();
    ingest.connect(transport);
    await ingest.startImport();
    await until(() => attempts === 1 && ingest.status().import.state === "done");
    assert.equal(ingest.status().import.failed.length, 1);
    assert.deepEqual(await ingest.plan({}, undefined, { resume: true }), []);
    assert.equal((await ingest.plan()).length, 1);
  } finally { await ingest.close(AbortSignal.timeout(2_000)); await w.cleanup(); }
});

test("Cohub's own Turns are recognized by their marker; a terminal Turn after one continues its Session", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const cloudTurnId = randomUUID(), sessionId = randomUUID();
    server.turns.set(cloudTurnId, { sessionId, settled: true, parentTurnId: null });
    const id = randomUUID();
    const path = join(w.piDirectory(w.project), "mixed.jsonl");
    await w.write(path, piHeader(id, w.project)
      + line({ type: "custom", customType: "cohub.turn", data: { turnId: cloudTurnId }, id: "m1", parentId: null, timestamp: at })
      + piMessage("u1", "m1", "user", "from the web") + piMessage("a1", "u1", "assistant", [{ type: "text", text: "ok" }], { stopReason: "stop" })
      + piMessage("u2", "a1", "user", "from the terminal") + piMessage("a2", "u2", "assistant", [{ type: "text", text: "ok" }], { stopReason: "stop" }));
    await utimes(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const ingest = w.ingest();
    await ingest.load();
    ingest.connect(server.transport);
    await until(() => server.turns.size === 2);
    const terminal = server.turns.get(turnIdOf("pi", id, "u2"));
    assert.equal(terminal?.parentTurnId, cloudTurnId);
    assert.equal(terminal?.sessionId, sessionId);
    assert(!server.batches.some((batch) => batch.turns.some((turn) => turn.turnId === cloudTurnId)), "a Cohub Turn is never sent back");
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("a running Cohub Turn marked by Codex user_message client_id is not reuploaded", async () => {
  const w = await workspace();
  const ingest = w.ingest({ harnesses: ["codex"] });
  try {
    const server = fakeServer();
    const cloudTurnId = randomUUID(), sessionId = randomUUID(), nativeTurnId = randomUUID(), id = randomUUID();
    server.turns.set(cloudTurnId, { sessionId, settled: false, parentTurnId: null });
    await w.write(w.codexPath(id), line({ timestamp: at, type: "session_meta", payload: { id, cwd: w.project } })
      + codexLine({ type: "task_started", turn_id: nativeTurnId })
      + codexLine({ type: "user_message", message: "from the web", client_id: cloudTurnId }));
    await ingest.load();
    ingest.connect(server.transport);
    await until(() => server.knownCalls > 0);
    await ingest.close(AbortSignal.timeout(2_000));
    assert.equal(server.batches.length, 0);
    assert.equal(server.turns.size, 1);
  } finally {
    await ingest.close(AbortSignal.timeout(2_000));
    await w.cleanup();
  }
});

test("a local Codex continuation uploads once under the Session identified by user_message client_id", async () => {
  const w = await workspace();
  const ingest = w.ingest({ harnesses: ["codex"] });
  try {
    const server = fakeServer();
    const cloudTurnId = randomUUID(), sessionId = randomUUID(), nativeTurnId = randomUUID(), localTurnId = randomUUID(), id = randomUUID();
    server.turns.set(cloudTurnId, { sessionId, settled: true, parentTurnId: null });
    await w.write(w.codexPath(id), line({ timestamp: at, type: "session_meta", payload: { id, cwd: w.project } })
      + codexLine({ type: "task_started", turn_id: nativeTurnId })
      + codexLine({ type: "user_message", message: "from the web", client_id: cloudTurnId })
      + codexLine({ type: "task_complete", turn_id: nativeTurnId, last_agent_message: "web answer" })
      + codexLine({ type: "task_started", turn_id: localTurnId })
      + codexLine({ type: "user_message", message: "from the terminal" })
      + codexLine({ type: "task_complete", turn_id: localTurnId, last_agent_message: "local answer" }));
    await ingest.load();
    ingest.connect(server.transport);
    await until(() => server.knownCalls > 0);
    await ingest.close(AbortSignal.timeout(2_000));
    const localId = turnIdOf("codex", id, localTurnId);
    const sent = server.batches.flatMap((batch) => batch.turns);
    assert.deepEqual(sent.map((turn) => turn.turnId), [localId], "only the unmarked local continuation is uploaded");
    assert.equal(sent[0]?.parentTurnId, cloudTurnId);
    assert.deepEqual(sent[0]?.userContent, [{ type: "text", text: "from the terminal" }]);
    assert.equal(sent[0]?.result?.status, "completed");
    assert.equal(server.turns.size, 2);
    assert.equal(server.turns.get(localId)?.sessionId, sessionId);
  } finally {
    await ingest.close(AbortSignal.timeout(2_000));
    await w.cleanup();
  }
});

test("a running Codex Turn is sent without a result, then settles in place", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const id = randomUUID();
    const path = w.codexPath(id);
    await w.write(path, [
      line({ timestamp: at, type: "session_meta", payload: { id, cwd: w.project } }),
      line({ timestamp: at, type: "event_msg", payload: { type: "turn_started", turn_id: "k1" } }),
      line({ timestamp: at, type: "event_msg", payload: { type: "user_message", message: "long task" } }),
    ].join(""));
    const ingest = w.ingest({ harnesses: ["codex"] });
    await ingest.load();
    ingest.connect(server.transport);
    const turnId = turnIdOf("codex", id, "k1");
    await until(() => server.turns.has(turnId));
    assert.equal(server.turns.get(turnId)?.settled, false);
    assert.equal(ingest.running("codex", id)?.runningTurnKey, "k1", "a stop request can name the native Turn");
    await appendFile(path, line({ timestamp: at, type: "event_msg", payload: { type: "turn_complete", turn_id: "k1", last_agent_message: "done" } }));
    ingest.touch(path);
    await until(() => server.turns.get(turnId)?.settled === true);
    assert.equal(ingest.running("codex", id), null);
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("history waits for an import, which runs newest first, pauses, resumes and never duplicates", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const enabledAt = new Date().toISOString();
    const ids = Array.from({ length: 6 }, () => randomUUID());
    for (const [index, id] of ids.entries()) {
      await w.write(w.codexPath(id), codexRollout(id, w.project, [`${id}-1`, `${id}-2`]), new Date(Date.parse("2025-01-01T00:00:00Z") + index * 60_000));
    }
    const ingest = w.ingest({ enabledAt, harnesses: ["codex"] });
    await ingest.load();
    ingest.connect(server.transport);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(server.turns.size, 0, "conversations from before sync are not taken without consent");
    const plan = await ingest.plan();
    assert.deepEqual(plan.map((item) => item.nativeSessionId), [...ids].reverse(), "newest first");
    const job = await ingest.startImport({}, 1);
    assert.equal(job.files, 6);
    await until(() => server.turns.size >= 2);
    ingest.pauseImport();
    await until(() => ingest.status().import.running === 0);
    const imported = server.turns.size;
    assert(imported < 12, "a pause stops taking new conversations");
    assert.equal(server.turns.get(`${turnIdOf("codex", ids[5] as string, `${ids[5]}-1`)}`)?.origin, "local_import");
    await ingest.close(AbortSignal.timeout(2_000));

    const resumed = w.ingest({ enabledAt, harnesses: ["codex"] });
    await resumed.load();
    resumed.connect(server.transport);
    const again = await resumed.startImport({}, 4);
    assert(again.files === 6 && again.done > 0, "resuming keeps progress");
    await until(() => resumed.status().import.state === "done");
    assert.equal(server.turns.size, 12);
    const sent = server.batches.flatMap((batch) => batch.turns.map((turn) => turn.turnId));
    assert.equal(new Set(sent).size, sent.length, "no Turn is sent twice");
    await resumed.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("between a Turn's start and end, new bytes are searched for boundaries, never parsed or sent", async () => {
  const w = await workspace();
  const controller = new AbortController();
  try {
    const server = fakeServer();
    const grown: TranscriptState[] = [];
    const id = randomUUID();
    const path = w.codexPath(id);
    await w.write(path, codexLine({ id, cwd: w.project }, "session_meta") + codexLine({ type: "turn_started", turn_id: "k1" })
      + codexLine({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "input_text", text: "go" }] } }));
    const ingest = w.ingest({ harnesses: ["codex"], hooks: { onGrowth: (state) => grown.push(state) } });
    await ingest.load();
    await ingest.watch(controller.signal);
    ingest.connect(server.transport);
    const turnId = turnIdOf("codex", id, "k1");
    await until(() => server.turns.has(turnId));
    const calls = { batches: server.batches.length, known: server.knownCalls };
    for (let index = 0; index < 20; index += 1) {
      await appendFile(path, codexLine({ type: "message", role: "assistant", content: [{ type: "output_text", text: `step ${index}` }] }, "response_item"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await until(() => grown.length > 0);
    assert.deepEqual({ batches: server.batches.length, known: server.knownCalls }, calls, "a running Turn's growth is realtime, not persistence");
    await appendFile(path, codexLine({ type: "turn_complete", turn_id: "k1", last_agent_message: "done" }));
    await until(() => server.turns.get(turnId)?.settled === true);
    const final = server.batches.at(-1)?.turns[0]?.result?.messages.at(-1)?.content;
    assert.deepEqual(final, [{ type: "text", text: "step 19" }], "the end is read once, with everything in it");
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { controller.abort(); await w.cleanup(); }
});

test("a Codex prompt is sent only once its final form is written, and a running Turn is registered once", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const id = randomUUID();
    const path = w.codexPath(id);
    await w.write(path, codexLine({ id, cwd: w.project }, "session_meta") + codexLine({ type: "turn_started", turn_id: "k1" })
      + codexLine({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context/>" }] }, "response_item"));
    const ingest = w.ingest({ harnesses: ["codex"] });
    await ingest.load();
    ingest.connect(server.transport);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(server.batches.length, 0, "an unfinished prompt is not sent");
    await appendFile(path, codexLine({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "input_text", text: "typed" }] } }));
    ingest.touch(path);
    const turnId = turnIdOf("codex", id, "k1");
    await until(() => server.turns.has(turnId));
    assert.deepEqual(server.batches[0]?.turns[0]?.userContent, [{ type: "text", text: "typed" }]);
    for (let index = 0; index < 3; index += 1) {
      await appendFile(path, codexLine({ type: "item_completed", item: { type: "AgentMessage" } }));
      ingest.touch(path);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(server.batches.length, 1, "a registered running Turn is not sent again");
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("a stop reaches the Turn's harness, including one requested while the Runtime was offline", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const stopped: string[] = [];
    const id = randomUUID();
    const path = w.codexPath(id);
    await w.write(path, codexLine({ id, cwd: w.project }, "session_meta") + codexLine({ type: "turn_started", turn_id: "k1" }) + codexLine({ type: "user_message", message: "long" }));
    const hooks: IngestHooks = { abortTurn: (state) => stopped.push(state.runningTurnKey ?? ""), controllable: () => true };
    const ingest = w.ingest({ harnesses: ["codex"], hooks });
    await ingest.load();
    ingest.connect(server.transport);
    const turnId = turnIdOf("codex", id, "k1");
    await until(() => server.turns.has(turnId));
    assert.equal(server.batches[0]?.turns[0]?.controllable, true, "the server learns the Turn can be stopped from the web");
    const sessionId = server.turns.get(turnId)?.sessionId as string;
    assert.equal(ingest.stop(sessionId, randomUUID()), false, "another Turn is not ours to stop");
    assert.equal(ingest.stop(sessionId, turnId), true);
    assert.deepEqual(stopped, ["k1"]);
    ingest.connect(null);
    server.stop.add(turnId);
    ingest.connect(server.transport);
    await until(() => stopped.length === 2);
    assert.deepEqual(server.statusRequests, [turnId, turnId], "asked when it starts running and once per reconnect, never polled");
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("a Codex Turn cut off by its client's death is recorded as interrupted once the next Turn begins", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const id = randomUUID();
    await w.write(w.codexPath(id), codexLine({ id, cwd: w.project }, "session_meta")
      + codexLine({ type: "turn_started", turn_id: "killed" }) + codexLine({ type: "user_message", message: "q killed" })
      + codexRollout(id, w.project, ["next"]).split("\n").slice(1).join("\n"));
    const ingest = w.ingest({ harnesses: ["codex"] });
    await ingest.load();
    ingest.connect(server.transport);
    await until(() => server.turns.size === 2);
    const killed = server.batches.flatMap((batch) => batch.turns).find((turn) => turn.turnId === turnIdOf("codex", id, "killed"));
    assert.equal(killed?.result?.status, "interrupted", "never left running on the server");
    assert(server.turns.get(turnIdOf("codex", id, "killed"))?.settled);
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("pausing a harness stops its uploads and previews, for transcripts already tracked too", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const id = randomUUID();
    const path = w.codexPath(id);
    await w.write(path, codexLine({ id, cwd: w.project }, "session_meta") + codexLine({ type: "turn_started", turn_id: "k1" }) + codexLine({ type: "user_message", message: "long" }));
    const ingest = w.ingest({ harnesses: ["codex"], hooks: { controllable: () => true } });
    await ingest.load();
    ingest.connect(server.transport);
    await until(() => server.turns.size === 1);
    assert(ingest.running("codex", id));
    const turnId = turnIdOf("codex", id, "k1");
    ingest.controlChanged("codex", id);
    ingest.configure([], new Date(0).toISOString());
    assert.equal(ingest.running("codex", id), null, "no live preview for a paused harness");
    await until(() => server.controllable.get(turnId) === false);
    assert.equal(ingest.transcriptFor(server.turns.get(turnId)?.sessionId as string, "codex", turnId), null, "nor is its file continued in place");
    const batches = server.batches.length;
    await appendFile(path, codexLine({ type: "turn_complete", turn_id: "k1", last_agent_message: "done" }));
    ingest.touch(path);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(server.batches.length, batches, "nothing more is uploaded");
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("Claude Code terminal Turns sync and settle on their recorded end; Cohub's prompt id marks its own Turn", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const cloudTurnId = randomUUID(), sessionId = randomUUID(), id = randomUUID(), cwd = join(w.project, "sub");
    server.turns.set(cloudTurnId, { sessionId, settled: true, parentTurnId: null });
    const path = w.claudePath(cwd, id);
    // Fresh bytes: a recorded end settles the Turn without waiting for a quiet period.
    await w.write(path, claudeTurn(id, cwd, cloudTurnId, null, "from the web", false) + claudeTurn(id, cwd, "u2", `a-${cloudTurnId}`, "from the terminal"));
    await w.write(join(path.slice(0, -".jsonl".length), "subagents", "agent-x.jsonl"), claudeTurn(id, cwd, "s1", null, "sub-agent"));
    const ingest = w.ingest({ harnesses: ["claude"] });
    await ingest.load();
    ingest.connect(server.transport);
    await until(() => server.turns.size === 2);
    const terminal = server.batches.flatMap((batch) => batch.turns);
    assert.deepEqual(terminal.map((turn) => [turn.turnId, turn.parentTurnId, turn.result?.status]), [[turnIdOf("claude", id, "u2"), cloudTurnId, "completed"]]);
    assert.equal(server.turns.get(turnIdOf("claude", id, "u2"))?.sessionId, sessionId);
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("a WorkBuddy Turn Cohub runs is never sent back, and a terminal Turn after it continues its Session", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const cloudTurnId = randomUUID(), sessionId = randomUUID(), id = randomUUID();
    server.turns.set(cloudTurnId, { sessionId, settled: true, parentTurnId: null });
    const path = w.workbuddyPath(w.project, id);
    const session = { harness: "workbuddy" as const, path, nativeSessionId: id, cwd: w.project };
    const ingest = w.ingest({ harnesses: ["workbuddy"] });
    await ingest.load();
    ingest.connect(server.transport);
    ingest.begin(session, sessionId, cloudTurnId);
    await w.write(path, workbuddyTurn(id, w.project, "u1", null, "from the web"));
    ingest.touch(path);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(server.batches.length, 0, "a running Cohub Turn is not read");
    ingest.advance(path, cloudTurnId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(server.batches.length, 0, "nor sent once it ends");
    await appendFile(path, workbuddyTurn(id, w.project, "u2", "a-u1", "from the terminal") + line({ id: "metrics", timestamp: 3, type: "turn-metrics", cwd: w.project }));
    ingest.touch(path);
    await until(() => server.turns.size === 2);
    assert.deepEqual(server.batches.flatMap((batch) => batch.turns).map((turn) => [turn.turnId, turn.parentTurnId]), [[turnIdOf("workbuddy", id, "u2"), cloudTurnId]]);
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("Cursor terminal Turns sync through their chat's project; a Turn Cohub runs is never sent back", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const cloudTurnId = randomUUID(), sessionId = randomUUID(), id = randomUUID(), terminal = randomUUID(), cwd = join(w.project, "sub");
    server.turns.set(cloudTurnId, { sessionId, settled: true, parentTurnId: null });
    await w.write(join(cursorChatDirectory(terminal, cwd), "meta.json"), JSON.stringify({ cwd }));
    await w.write(cursorTranscriptPath(terminal, cwd), cursorTurn("from the terminal"));
    await w.write(join(cursorTranscriptPath(terminal, cwd), "..", "subagents", "s1.jsonl"), cursorTurn("sub-agent"));
    const path = cursorTranscriptPath(id, w.project);
    const ingest = w.ingest({ harnesses: ["cursor"] });
    await ingest.load();
    ingest.connect(server.transport);
    await until(() => server.turns.size === 2);
    const [synced] = server.batches.flatMap((batch) => batch.turns);
    assert.deepEqual([synced?.turnId, synced?.userContent, synced?.result?.status], [turnIdOf("cursor", terminal, cursorKey(cursorPrompt("from the terminal"))), [{ type: "text", text: "from the terminal" }], "completed"]);

    ingest.begin({ harness: "cursor", path, nativeSessionId: id, cwd: w.project }, sessionId, cloudTurnId);
    await w.write(join(cursorChatDirectory(id, w.project), "meta.json"), JSON.stringify({ cwd: w.project }));
    await w.write(path, cursorTurn("from the web"));
    ingest.advance(path, cloudTurnId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(server.turns.size, 2, "a Cohub Turn is not sent back");
    await appendFile(path, cursorTurn("then the terminal"));
    ingest.touch(path);
    await until(() => server.turns.size === 3);
    const key = cursorKey(cursorTurn("from the web") + cursorPrompt("then the terminal"));
    assert.deepEqual(server.batches.flatMap((batch) => batch.turns).slice(1).map((turn) => [turn.turnId, turn.parentTurnId]), [[turnIdOf("cursor", id, key), cloudTurnId]]);

    // Cohub's Turn left no record: the head it adopted still parents the terminal Turn that follows.
    const empty = randomUUID(), emptyPath = cursorTranscriptPath(empty, w.project);
    ingest.adopt({ harness: "cursor", path: emptyPath, nativeSessionId: empty, cwd: w.project }, sessionId, { turnKey: null, turnId: cloudTurnId });
    await w.write(join(cursorChatDirectory(empty, w.project), "meta.json"), JSON.stringify({ cwd: w.project }));
    await w.write(emptyPath, cursorTurn("first in the terminal"));
    ingest.touch(emptyPath);
    await until(() => server.turns.size === 4);
    assert.equal(server.batches.flatMap((batch) => batch.turns).at(-1)?.parentTurnId, cloudTurnId);
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});

test("a Claude Code file Cohub wrote before marking its Turns is history the server has", async () => {
  const w = await workspace();
  try {
    const server = fakeServer();
    const head = randomUUID(), sessionId = randomUUID(), id = randomUUID();
    server.turns.set(head, { sessionId, settled: true, parentTurnId: null });
    const path = w.claudePath(w.project, id);
    await w.write(path, claudeTurn(id, w.project, "old1", null, "unmarked", false) + claudeTurn(id, w.project, "old2", "a-old1", "unmarked", false));
    const first = w.ingest({ harnesses: [] });
    first.adopt({ harness: "claude", path, nativeSessionId: id, cwd: w.project }, sessionId);
    first.advance(path, head);
    await first.close(AbortSignal.timeout(2_000));
    const ingest = w.ingest({ harnesses: ["claude"] });
    await ingest.load();
    ingest.connect(server.transport);
    await until(() => server.knownCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(server.batches.length, 0, "its unmarked Turns are not sent");
    await appendFile(path, claudeTurn(id, w.project, "u3", "a-old2", "from the terminal"));
    ingest.touch(path);
    await until(() => server.turns.size === 2);
    assert.deepEqual(server.batches.flatMap((batch) => batch.turns).map((turn) => [turn.turnId, turn.parentTurnId]), [[turnIdOf("claude", id, "u3"), head]]);
    await ingest.close(AbortSignal.timeout(2_000));
  } finally { await w.cleanup(); }
});
