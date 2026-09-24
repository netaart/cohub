import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { piSessionDirectoryName } from "../src/runtime/native/adapters.js";
import { nativeTurnId } from "../src/runtime/native/identity.js";
import { discoverTranscripts, NativeIngest, type IngestHooks, type TranscriptState } from "../src/runtime/native/ingest.js";
import { fakeNativeServer as fakeServer } from "./fixtures/native-server.js";

const at = "2026-01-01T00:00:00.000Z";
const SPACE = "00000000-0000-4000-8000-000000000001";
const turnIdOf = (harness: "pi" | "codex", nativeSessionId: string, key: string) => nativeTurnId(SPACE, harness, nativeSessionId, key);
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
  const piDirectory = (cwd: string) => join(root, "pi-agent", "sessions", piSessionDirectoryName(cwd));
  const codexPath = (id: string) => join(root, "codex-home", "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  const ingest = (options: { enabledAt?: string; harnesses?: Array<"pi" | "codex">; hooks?: IngestHooks } = {}) => new NativeIngest({
    spaceId: SPACE, cwd: project, harnesses: options.harnesses ?? ["pi", "codex"], enabledAt: options.enabledAt ?? new Date(0).toISOString(),
    root: join(root, "state"), archives: new RuntimeArchiveStore(join(root, "state", "archives"), null), hooks: options.hooks,
  });
  const write = async (path: string, content: string, mtime?: Date) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    if (mtime) await utimes(path, mtime, mtime);
  };
  return { root, project, piDirectory, codexPath, ingest, write, cleanup: () => rm(root, { recursive: true, force: true }) };
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
