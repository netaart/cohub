import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RuntimeExecutionEvent, RuntimeTurnInput } from "@neta-art/cohub";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { RuntimeDiagnostics } from "../src/runtime/diagnostics.js";
import { antigravityHarness } from "../src/runtime/harnesses/antigravity.js";
import {
  acceptsAntigravityDirectory,
  acceptsAntigravityTranscript,
  antigravitySessionHeader,
  antigravityTranscriptPath,
  extractAntigravityUserText,
  readAntigravityTranscript,
} from "../src/runtime/harnesses/antigravity-transcript.js";
import { discoverHarnesses } from "../src/runtime/harnesses/index.js";
import { NativeRuntime } from "../src/runtime/native/daemon.js";
import { executeTurn } from "../src/runtime/native/execution.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";
import { runtimeProjectionSource } from "./fixtures/runtime-projection-source.js";

const fixture = fileURLToPath(new URL("./fixtures/runtime-antigravity.mjs", import.meta.url));
const ENV = ["HOME", "ANTIGRAVITY_FIXTURE", "ANTIGRAVITY_FIXTURE_LOG", "PATH"] as const;

async function withEnvironment(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cohub-antigravity-"));
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  process.env.HOME = join(root, "home");
  process.env.ANTIGRAVITY_FIXTURE_LOG = join(root, "calls.jsonl");
  delete process.env.ANTIGRAVITY_FIXTURE;
  await chmod(fixture, 0o755);
  await mkdir(join(root, "bin"));
  await symlink(fixture, join(root, "bin", "agy"));
  process.env.PATH = `${join(root, "bin")}:${previous.PATH ?? ""}`;
  try { await run(root); } finally {
    for (const key of ENV) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}

const calls = async (root: string) => (await readFile(join(root, "calls.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; settings: { permissions?: { deny?: string[] } } });
const reply = (result: { event: { message: { content: unknown[] } } }) => JSON.stringify(result.event.message.content);

test("Antigravity discovery groups effort variants into thinking levels and explains a failed startup check", () => withEnvironment(async (root) => {
  const catalog = await discoverHarnesses(["antigravity"], {}, root);
  assert.deepEqual(catalog.harnesses, ["antigravity"]);
  assert.deepEqual(catalog.models.map((model) => [model.id, model.name, model.provider, model.reasoning]), [
    ["default", "Default", "antigravity", false],
    ["gemini-4-neon", "Gemini 4 Neon", "google", true],
    ["gemini-pro-orchestrator", "Orchestrator (Carbon)", "google", false],
    ["claude-opus-5-5", "Claude Opus 5.5", "anthropic", true],
  ]);
  assert.equal(catalog.models[1]?.thinkingLevelMap?.high, "high");
  assert.equal(catalog.models[1]?.thinkingLevelMap?.medium, null);
  assert.deepEqual(catalog.approvalModes?.antigravity, ["inherit", "full_access", "read_only"]);

  for (const [mode, reason] of [["signed-out", /Please sign in to view available models/], ["old", /missing --settings/]] as const) {
    process.env.ANTIGRAVITY_FIXTURE = mode;
    const skipped: string[] = [];
    const empty = await discoverHarnesses(["antigravity"], {}, root, (harness, error) => skipped.push(`${harness}:${(error as Error).message}`));
    assert.deepEqual(empty.harnesses, []);
    assert.match(skipped[0] ?? "", reason);
  }
}));

test("Antigravity Turns hand over history, resume by conversation, enforce read-only and stop", () => withEnvironment(async (root) => {
  const spaceId = randomUUID(), sessionId = randomUUID(), history = randomUUID();
  const source = runtimeProjectionSource();
  source.addTurn(sessionId, history, { userContent: [{ type: "text", text: "remember fact-one" }], assistantContent: [{ type: "text", text: "noted" }] });
  const storage = await archiveStorageFixture();
  const stateRoot = join(root, "state");
  const native = new NativeRuntime({
    spaceId, root, stateRoot, harnesses: ["antigravity"], executables: {}, identity: "test", config: null,
    archives: new RuntimeArchiveStore(join(stateRoot, "archives"), storage.transport), projectionSource: source,
    diagnostics: new RuntimeDiagnostics({ root: stateRoot, spaceId }),
  });
  const turn = (throughTurnId: string | null, content: RuntimeTurnInput["messages"][number]["content"], options: Partial<RuntimeTurnInput> = {}): RuntimeTurnInput => {
    const turnId = randomUUID();
    return {
      spaceId, sessionId, turnId, userMessageId: turnId, harness: "antigravity", accessMode: "full_access", ...options,
      messages: [{ turnId, userMessageId: turnId, userId: "author", content }],
      context: { revision: randomUUID(), throughTurnId, messages: [] },
    };
  };
  const run = async (input: RuntimeTurnInput, signal = new AbortController().signal, events: RuntimeExecutionEvent[] = []) => {
    const result = await executeTurn(native.executor, input, (event) => events.push(event), signal, null);
    await native.executor.results.record(result.session, input, null, [result.event]);
    await native.executor.results.acknowledge(input.sessionId, input.turnId);
    return result;
  };
  try {
    const first = turn(history, [{ type: "text", text: "hello" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "eA==" } }], { model: "gemini-4-neon", thinkingLevel: "high" });
    const firstResult = await run(first);
    assert.equal(firstResult.event.resume, "handoff");
    assert.equal(firstResult.event.archive, null);
    assert.deepEqual(firstResult.event.message.content, [{ type: "text", text: "history:fact-one model:gemini-4-neon effort:high skip:false images:1" }]);
    // Each step's own usage; the result's counts the whole conversation.
    assert.deepEqual(firstResult.event.message.usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17 });

    // Cohub's Turn is named by the step index its run reported, even beside an identical terminal Turn.
    assert.equal(native.executor.ingest.transcriptFor(sessionId, "antigravity", first.turnId)?.throughTurnId, first.turnId);
    const racedTurn = turn(null, [{ type: "text", text: "then-terminal" }], { sessionId: randomUUID() });
    const raced = await run(racedTurn);
    const [own, terminal] = (await readAntigravityTranscript(raced.session.path, raced.session.nativeSessionId)).turns;
    assert.deepEqual(terminal?.userContent, own?.userContent);
    assert.equal(native.executor.ingest.transcriptFor(racedTurn.sessionId, "antigravity", racedTurn.turnId)?.throughTurnKey, own?.key);

    const events: RuntimeExecutionEvent[] = [];
    const second = turn(first.turnId, [{ type: "text", text: "need-cmd" }], { approvalMode: "full_access" });
    const secondResult = await run(second, undefined, events);
    assert.equal(secondResult.event.resume, "native");
    assert.equal(secondResult.session.nativeSessionId, firstResult.session.nativeSessionId);
    assert.deepEqual(secondResult.event.message.content, [{ type: "text", text: "command done" }]);
    const committed = events.find((event) => event.type === "message.commit");
    assert.deepEqual(committed?.type === "message.commit" && committed.message.content, [
      { type: "tool_use", id: "agy-step-4", name: "run_command", input: { CommandLine: "echo hello" } },
      { type: "tool_result", tool_use_id: "agy-step-4", content: "ran\n", is_error: false },
    ]);

    // Headless mode cannot ask; a denial without an answer is reported, not silent.
    const deniedTurn = turn(second.turnId, [{ type: "text", text: "need-cmd" }]);
    const denied = await run(deniedTurn);
    assert.equal(denied.event.message.stopReason, "error");
    assert.match(denied.event.message.errorMessage ?? "", /Antigravity denied Bash/);

    // Read-only deny rules keep the user's own and win over --dangerously-skip-permissions.
    await mkdir(join(root, "home", ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(join(root, "home", ".gemini", "antigravity-cli", "settings.json"), `\uFEFF${JSON.stringify({ permissions: { deny: ["read_file(/secret)"], allow: ["command(echo)"] } })}`);
    await assert.rejects(run(turn(null, [{ type: "text", text: "need-cmd" }], { sessionId: randomUUID(), accessMode: "read_only", approvalMode: "full_access" })), /conflicts with read-only/);
    const readOnly = await run(turn(null, [{ type: "text", text: "need-cmd" }], { sessionId: randomUUID(), accessMode: "read_only" }));
    assert.match(reply(readOnly), /denied by rule/);
    const readOnlyCall = (await calls(root)).at(-1);
    assert.equal(readOnlyCall?.args.includes("--dangerously-skip-permissions"), false);
    assert.deepEqual(readOnlyCall?.settings.permissions?.deny, ["read_file(/secret)", "write_file(*)", "command(*)", "mcp(*)", "read_url(*)", "execute_url(*)", "download_url(*)"]);

    // A conversation Antigravity no longer has is not silently restarted without history.
    source.addTurn(sessionId, deniedTurn.turnId, { userContent: [{ type: "text", text: "fact-two" }], assistantContent: [{ type: "text", text: "ok" }] });
    await rm(join(root, "home", ".gemini", "antigravity-cli", "brain", firstResult.session.nativeSessionId), { recursive: true });
    const lost = await run(turn(deniedTurn.turnId, [{ type: "text", text: "again" }]));
    assert.equal(lost.event.resume, "handoff");
    assert.notEqual(lost.session.nativeSessionId, firstResult.session.nativeSessionId);
    assert.match(reply(lost), /history:fact-one,fact-two/);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const stopped = await run(turn(null, [{ type: "text", text: "sleep" }], { sessionId: randomUUID() }), controller.signal);
    assert.equal(stopped.event.message.stopReason, "aborted");
    assert.equal(stopped.event.message.errorMessage, null);
  } finally {
    await native.close(AbortSignal.timeout(2_000));
  }
}));

test("Antigravity transcript reader resolves cwd via SQLite, filters subagents, pairs tool results and reads transcript_full.jsonl", () => withEnvironment(async (root) => {
  const project = join(root, "proj");
  await mkdir(project, { recursive: true });
  const appDataRoot = join(root, "home", ".gemini", "antigravity-cli");
  await mkdir(appDataRoot, { recursive: true });

  const userConv = randomUUID();
  const childConv = randomUUID();
  const db = new DatabaseSync(join(appDataRoot, "conversation_summaries.db"));
  try {
    db.exec(`CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      workspace_uris text NOT NULL,
      parent_conversation_id text NOT NULL DEFAULT '',
      nesting_depth integer NOT NULL DEFAULT 0
    )`);
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, '', 0)").run(userConv, JSON.stringify([pathToFileURL(project).href]));
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, 1)").run(childConv, JSON.stringify([pathToFileURL(project).href]), userConv);
  } finally {
    db.close();
  }

  const userPath = antigravityTranscriptPath(userConv);
  const childPath = antigravityTranscriptPath(childConv);
  await mkdir(join(appDataRoot, "brain", userConv, ".system_generated", "logs"), { recursive: true });
  await mkdir(join(appDataRoot, "brain", childConv, ".system_generated", "logs"), { recursive: true });

  const brainRoot = join(appDataRoot, "brain");
  assert.equal(acceptsAntigravityDirectory(join(brainRoot, userConv), brainRoot, project), true);
  assert.equal(acceptsAntigravityDirectory(join(brainRoot, userConv, ".system_generated"), brainRoot, project), true);
  assert.equal(acceptsAntigravityDirectory(join(brainRoot, userConv, ".system_generated", "logs"), brainRoot, project), true);
  assert.equal(acceptsAntigravityDirectory(join(brainRoot, userConv, ".system_generated", "steps"), brainRoot, project), false);
  assert.equal(acceptsAntigravityTranscript(userPath, project), true);
  assert.equal(acceptsAntigravityTranscript(join(appDataRoot, "brain", userConv, ".system_generated", "logs", "transcript_full.jsonl"), project), false);

  const userHeader = await antigravitySessionHeader(userPath);
  assert.deepEqual(userHeader, { harness: "antigravity", nativeSessionId: userConv, cwd: project, thread: "user" });
  const childHeader = await antigravitySessionHeader(childPath);
  assert.equal(childHeader?.thread, "spawned");

  const lines = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-21T02:00:00Z", content: "<USER_REQUEST>\ncheck status\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-21T02:00:01Z", model: "gemini-4-neon-high", input_tokens: 100, cache_read_tokens: 20, output_tokens: 15, thinking: "let me check", tool_calls: [{ name: "run_command", args: { CommandLine: '"git status"' } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-21T02:00:02Z", content: "truncated...", truncated_fields: ["content"] },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-21T02:00:03Z", model: "gemini-4-neon-high", input_tokens: 120, output_tokens: 8, content: "All clean." },
  ];
  const fullLines = [
    ...lines.slice(0, 2),
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-21T02:00:02Z", content: "On branch main\nnothing to commit" },
    lines[3],
  ];
  await writeFile(userPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  await writeFile(join(appDataRoot, "brain", userConv, ".system_generated", "logs", "transcript_full.jsonl"), `${fullLines.map((l) => JSON.stringify(l)).join("\n")}\n`);

  const parsed = await readAntigravityTranscript(userPath, userConv);
  assert.equal(parsed.cwd, project);
  assert.equal(parsed.turns.length, 1);
  const firstTurn = parsed.turns[0];
  assert(firstTurn);
  assert.deepEqual(firstTurn.userContent, [{ type: "text", text: "check status" }]);
  assert.equal(firstTurn.messages.length, 2);
  assert.equal(firstTurn.messages[0]?.stopReason, "tool_use");
  const toolUse = firstTurn.messages[0]?.content.find((b) => b.type === "tool_use");
  const toolResult = firstTurn.messages[0]?.content.find((b) => b.type === "tool_result");
  assert.deepEqual(toolUse?.type === "tool_use" && toolUse.input, { CommandLine: "git status" });
  assert.equal(toolResult?.type === "tool_result" && toolResult.content, "On branch main\nnothing to commit");
  assert.deepEqual(firstTurn.messages[1]?.content, [{ type: "text", text: "All clean." }]);
  assert.equal(firstTurn.result?.status, "completed");
  assert.equal(antigravityHarness.transcript.replyEnded?.(firstTurn), true);

  assert.equal(extractAntigravityUserText("plain prompt\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>"), "plain prompt");
  assert.equal(extractAntigravityUserText("<USER_REQUEST>\n<cohub_session_history>\n[user]\nold\n</cohub_session_history>\n\nnew prompt\n</USER_REQUEST>"), "new prompt");
}));

test("Antigravity transcript clears stale result across background wakeups until final response settles", () => withEnvironment(async (root) => {
  const appDataRoot = join(root, "home", ".gemini", "antigravity-cli");
  const convId = randomUUID();
  const transcriptPath = antigravityTranscriptPath(convId);
  await mkdir(join(appDataRoot, "brain", convId, ".system_generated", "logs"), { recursive: true });

  const writeLines = async (entries: unknown[]) => {
    await writeFile(transcriptPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  };
  const readTurn = async (index = 0) => {
    const parsed = await readAntigravityTranscript(transcriptPath, convId);
    const turn = parsed.turns[index];
    assert(turn);
    return { parsed, turn };
  };

  const base: unknown[] = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-22T02:00:00.000Z", content: "<USER_REQUEST>run tests</USER_REQUEST>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T02:00:01.000Z", content: "Waiting for background command." },
  ];
  await writeLines(base);
  let { parsed, turn } = await readTurn();
  assert.equal(turn.result?.status, "completed");
  assert.equal(turn.result?.completedAt, "2026-11-22T02:00:01.000Z");
  assert.equal(antigravityHarness.transcript.replyEnded?.(turn), true);

  // Wakeup arrives in the same user turn: prior result must be cleared.
  base.push({ step_index: 2, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-22T02:00:05.000Z", content: "Background task exited 0" });
  await writeLines(base);
  ({ parsed, turn } = await readTurn());
  assert.equal(parsed.turns.length, 1);
  assert.equal(turn.result, null);
  assert.equal(antigravityHarness.transcript.replyEnded?.(turn), false);

  // Model issues follow-up tool call after wakeup: result remains null.
  base.push({
    step_index: 3,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-11-22T02:00:06.000Z",
    tool_calls: [{ name: "read_file", args: { Path: '"report.txt"' } }],
  });
  await writeLines(base);
  ({ parsed, turn } = await readTurn());
  assert.equal(turn.result, null);
  assert.equal(antigravityHarness.transcript.replyEnded?.(turn), false);

  // Tool finishes and an in-progress non-tool planner response starts: still not settled.
  base.push(
    { step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-22T02:00:07.000Z", content: "10 passed" },
    { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "RUNNING", created_at: "2026-11-22T02:00:08.000Z", thinking: "summarizing" },
  );
  await writeLines(base);
  ({ parsed, turn } = await readTurn());
  assert.equal(turn.result, null);
  assert.equal(turn.messages.at(-1)?.stopReason, null);
  assert.equal(antigravityHarness.transcript.replyEnded?.(turn), false);

  // Final non-tool response settles the turn with the new completion timestamp.
  base.push({ step_index: 6, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T02:00:09.000Z", content: "All 10 tests passed." });
  await writeLines(base);
  ({ parsed, turn } = await readTurn());
  assert.equal(turn.result?.status, "completed");
  assert.equal(turn.result?.completedAt, "2026-11-22T02:00:09.000Z");
  assert.equal(turn.result?.messages.length, turn.messages.length);
  assert.equal(antigravityHarness.transcript.replyEnded?.(turn), true);

  // Direct wakeup -> failed final response also transitions cleanly.
  base.push(
    { step_index: 7, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-22T02:01:00.000Z", content: "deploy" },
    { step_index: 8, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T02:01:01.000Z", content: "Triggered deploy." },
    { step_index: 9, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-22T02:01:05.000Z", content: "Deploy hook failed" },
    { step_index: 10, source: "MODEL", type: "PLANNER_RESPONSE", status: "ERROR", created_at: "2026-11-22T02:01:06.000Z", error: "Upstream unavailable" },
  );
  await writeLines(base);
  ({ parsed, turn } = await readTurn(1));
  assert.equal(parsed.turns.length, 2);
  assert.equal(turn.result?.status, "failed");
  assert.equal(turn.result?.completedAt, "2026-11-22T02:01:06.000Z");
  assert.equal(antigravityHarness.transcript.replyEnded?.(turn), true);
}));

test("Antigravity transcript clears pending tool ids and result on mid-turn ERROR_MESSAGE", () => withEnvironment(async (root) => {
  const appDataRoot = join(root, "home", ".gemini", "antigravity-cli");
  const convId = randomUUID();
  const transcriptPath = antigravityTranscriptPath(convId);
  await mkdir(join(appDataRoot, "brain", convId, ".system_generated", "logs"), { recursive: true });

  const lines = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-22T03:00:00.000Z", content: "inspect files" },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-22T03:00:01.000Z",
      tool_calls: [
        { name: "read_file", args: { Path: '"a.ts"' } },
        { name: "read_file", args: { Path: '"b.ts"' } },
      ],
    },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-22T03:00:02.000Z", content: "contents of a.ts" },
    { step_index: 3, source: "SYSTEM", type: "ERROR_MESSAGE", status: "ERROR", created_at: "2026-11-22T03:00:03.000Z", content: "stream interrupted, retrying" },
    // Orphaned GENERIC after ERROR_MESSAGE must not attach to the abandoned second tool_use_id.
    { step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-22T03:00:04.000Z", content: "stray output" },
    {
      step_index: 5,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-22T03:00:05.000Z",
      tool_calls: [{ name: "read_file", args: { Path: '"b.ts"' } }],
    },
    { step_index: 6, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-22T03:00:06.000Z", content: "contents of b.ts" },
    { step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T03:00:07.000Z", content: "Inspected both files." },
    // ERROR_MESSAGE after a completed response clears stale result until recovery settles.
    { step_index: 8, source: "SYSTEM", type: "ERROR_MESSAGE", status: "ERROR", created_at: "2026-11-22T03:00:08.000Z", content: "transient disconnect" },
  ];
  await writeFile(transcriptPath, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const parsed = await readAntigravityTranscript(transcriptPath, convId);
  const turn = parsed.turns[0];
  assert(turn);
  assert.equal(turn.messages.length, 3);

  const firstMsgToolUses = turn.messages[0]?.content.filter((block) => block.type === "tool_use") ?? [];
  const firstMsgToolResults = turn.messages[0]?.content.filter((block) => block.type === "tool_result") ?? [];
  assert.equal(firstMsgToolUses.length, 2);
  assert.equal(firstMsgToolResults.length, 1);
  assert.equal(firstMsgToolResults[0]?.type === "tool_result" && firstMsgToolResults[0].tool_use_id, firstMsgToolUses[0]?.type === "tool_use" && firstMsgToolUses[0].id);
  assert.equal(firstMsgToolResults[0]?.type === "tool_result" && firstMsgToolResults[0].content, "contents of a.ts");

  const retryToolUse = turn.messages[1]?.content.find((block) => block.type === "tool_use");
  const retryToolResult = turn.messages[1]?.content.find((block) => block.type === "tool_result");
  assert(retryToolUse?.type === "tool_use");
  assert(retryToolResult?.type === "tool_result");
  assert.equal(retryToolResult.tool_use_id, retryToolUse.id);
  assert.equal(retryToolResult.content, "contents of b.ts");
  assert.equal(turn.result, null);
}));

test("Antigravity transcript only hydrates transcript_full.jsonl for consumed truncated fields and needed step indices", () => withEnvironment(async (root) => {
  const appDataRoot = join(root, "home", ".gemini", "antigravity-cli");
  const convId = randomUUID();
  const logsDir = join(appDataRoot, "brain", convId, ".system_generated", "logs");
  const transcriptPath = antigravityTranscriptPath(convId);
  const fullPath = join(logsDir, "transcript_full.jsonl");
  await mkdir(logsDir, { recursive: true });

  // 1. Truncated fields we do not consume (and ignored step types) must not hydrate from transcript_full.jsonl.
  const skippedLines = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-22T04:00:00.000Z", content: "hello" },
    { step_index: 1, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-22T04:00:01.000Z", content: "truncated sys", truncated_fields: ["content"] },
    { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T04:00:02.000Z", content: "compact reply", truncated_fields: ["metadata"] },
  ];
  await writeFile(transcriptPath, `${skippedLines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await writeFile(
    fullPath,
    `${JSON.stringify({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T04:00:02.000Z", content: "SHOULD_NOT_HYDRATE" })}\n`,
  );

  const skippedParsed = await readAntigravityTranscript(transcriptPath, convId);
  assert.deepEqual(skippedParsed.turns[0]?.messages[0]?.content, [{ type: "text", text: "compact reply" }]);

  // 2. When consumed fields are truncated, only needed step_index lines are parsed and hydrated.
  const selectiveLines = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-22T04:01:00.000Z", content: "check full" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T04:01:01.000Z", thinking: "trunc...", tool_calls: [], truncated_fields: ["thinking", "tool_calls"] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-22T04:01:02.000Z", content: "compact tool output" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T04:01:03.000Z", content: "trunc...", truncated_fields: ["content"] },
  ];
  const fullContent = [
    // Unneeded step 0 with invalid JSON after prefix is skipped without JSON.parse.
    '{"step_index":0,"source":"USER_EXPLICIT",NOT_VALID_JSON',
    JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-22T04:01:01.000Z",
      thinking: "full reasoning trace",
      tool_calls: [{ name: "run_command", args: { CommandLine: '"ls"' } }],
    }),
    // Unneeded step 2 must not replace compact content.
    JSON.stringify({ step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-22T04:01:02.000Z", content: "SHOULD_NOT_REPLACE" }),
    // Needed step 3 where step_index is not the first JSON property still hydrates via fallback.
    JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T04:01:03.000Z", content: "full final answer", step_index: 3 }),
  ].join("\n");

  await writeFile(transcriptPath, `${selectiveLines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await writeFile(fullPath, `${fullContent}\n`);

  const selectiveParsed = await readAntigravityTranscript(transcriptPath, convId);
  const turn = selectiveParsed.turns[0];
  assert(turn);
  assert.deepEqual(turn.userContent, [{ type: "text", text: "check full" }]);
  assert.equal(turn.messages.length, 2);
  const thinkingBlock = turn.messages[0]?.content.find((block) => block.type === "thinking");
  const toolUseBlock = turn.messages[0]?.content.find((block) => block.type === "tool_use");
  const toolResultBlock = turn.messages[0]?.content.find((block) => block.type === "tool_result");
  assert.equal(thinkingBlock?.type === "thinking" && thinkingBlock.thinking, "full reasoning trace");
  assert.deepEqual(toolUseBlock?.type === "tool_use" && toolUseBlock.input, { CommandLine: "ls" });
  assert.equal(toolResultBlock?.type === "tool_result" && toolResultBlock.content, "compact tool output");
  assert.deepEqual(turn.messages[1]?.content, [{ type: "text", text: "full final answer" }]);
}));
