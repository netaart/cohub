import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ApprovalDecision, RuntimeExecutionEvent, RuntimeTurnInput } from "@neta-art/cohub";
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
import { discoverTranscripts } from "../src/runtime/native/ingest.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";
import { runtimeProjectionSource } from "./fixtures/runtime-projection-source.js";

const fixture = fileURLToPath(new URL("./fixtures/runtime-antigravity.mjs", import.meta.url));
const ENV = ["ANTIGRAVITY_GEMINI_DIR", "ANTIGRAVITY_DATA_DIR", "ANTIGRAVITY_FIXTURE", "PATH"] as const;

async function withEnvironment(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cohub-antigravity-"));
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  process.env.ANTIGRAVITY_GEMINI_DIR = join(root, "gemini");
  process.env.ANTIGRAVITY_DATA_DIR = "antigravity-cli";
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

test("Antigravity discovery reports models, thinking levels, and approval modes; skips when models missing", () => withEnvironment(async (root) => {
  const catalog = await discoverHarnesses(["antigravity"], {}, root);
  assert.deepEqual(catalog.harnesses, ["antigravity"]);
  assert.deepEqual(catalog.models.map((m) => m.id), ["default", "gemini-4-neon", "claude-opus-5-5", "gpt-oss-120b-medium"]);
  assert.equal(catalog.models[0]?.isDefault, true);
  assert.equal(catalog.models[1]?.provider, "google");
  assert.equal(catalog.models[1]?.reasoning, true);
  assert.equal(catalog.models[1]?.thinkingLevelMap?.high, "high");
  assert.equal(catalog.models[2]?.provider, "anthropic");
  assert.equal(catalog.models[3]?.reasoning, false);
  assert.deepEqual(catalog.approvalModes?.antigravity, ["inherit", "auto", "full_access", "read_only"]);

  process.env.ANTIGRAVITY_FIXTURE = "no-models";
  const skipped: string[] = [];
  const empty = await discoverHarnesses(["antigravity"], {}, root, (harness, error) => skipped.push(`${harness}:${(error as Error).message}`));
  assert.deepEqual(empty.harnesses, []);
  assert.match(skipped[0] ?? "", /lists no models/);
}));

test("Antigravity Turns hand over Cohub history, stream thinking/tools/text, resume natively, enforce approvals and cancel", () => withEnvironment(async (root) => {
  const spaceId = randomUUID();
  const sessionId = randomUUID();
  const history = randomUUID();
  const source = runtimeProjectionSource();
  source.addTurn(sessionId, history, {
    userContent: [{ type: "text", text: "historical fact" }],
    assistantContent: [{ type: "text", text: "noted" }],
  });
  const storage = await archiveStorageFixture();
  const stateRoot = join(root, "state");
  const diagnostics = new RuntimeDiagnostics({ root: stateRoot, spaceId });
  const native = new NativeRuntime({
    spaceId,
    root,
    stateRoot,
    harnesses: ["antigravity"],
    executables: {},
    identity: "test",
    config: null,
    archives: new RuntimeArchiveStore(join(stateRoot, "archives"), storage.transport),
    projectionSource: source,
    diagnostics,
  });

  const makeTurn = (
    throughTurnId: string | null,
    content: RuntimeTurnInput["messages"][number]["content"],
    options: Partial<RuntimeTurnInput> = {},
  ): RuntimeTurnInput => {
    const turnId = randomUUID();
    return {
      spaceId,
      sessionId,
      turnId,
      userMessageId: turnId,
      harness: "antigravity",
      accessMode: "full_access",
      ...options,
      messages: [{ turnId, userMessageId: turnId, userId: "author", content }],
      context: { revision: randomUUID(), throughTurnId, messages: [] },
    };
  };

  const settle = async (input: RuntimeTurnInput, result: Awaited<ReturnType<typeof executeTurn>>) => {
    await native.executor.results.record(result.session, input, null, [result.event]);
    await native.executor.results.acknowledge(input.sessionId, input.turnId);
  };

  try {
    // 1. Handoff + streaming thought, tool_call, tool_result, message, usage, image
    const events: RuntimeExecutionEvent[] = [];
    const first = makeTurn(
      history,
      [{ type: "text", text: "with-read" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "eA==" } }],
      { model: "default", thinkingLevel: "medium" },
    );
    const firstResult = await executeTurn(native.executor, first, (event) => events.push(event), new AbortController().signal, null);
    assert.equal(firstResult.event.resume, "handoff");
    assert.equal(firstResult.event.archive, null);
    assert.deepEqual(firstResult.event.message.content, [{ type: "text", text: "history retained mode:default model:gemini-4-neon effort:medium images:1" }]);
    assert.deepEqual(firstResult.event.message.usage, { input: 12, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 19 });
    const committed = events.find((event) => event.type === "message.commit");
    assert.deepEqual(committed?.type === "message.commit" && committed.message.content, [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "Reading" },
      { type: "tool_use", id: "c1", name: "read_file", input: { Path: "a.txt" } },
      { type: "tool_result", tool_use_id: "c1", content: "ok", is_error: false },
    ]);
    await settle(first, firstResult);

    // 2. Native resume with explicit model & effort
    const second = makeTurn(first.turnId, [{ type: "text", text: "continue" }], { model: "claude-opus-5-5", thinkingLevel: "low", approvalMode: "auto" });
    const secondResult = await executeTurn(native.executor, second, () => {}, new AbortController().signal, null);
    assert.equal(secondResult.event.resume, "native");
    assert.equal(secondResult.session.nativeSessionId, firstResult.session.nativeSessionId);
    assert.deepEqual(secondResult.event.message.content, [{ type: "text", text: "history retained mode:auto model:claude-opus-5-5 effort:low" }]);
    await settle(second, secondResult);

    // 3. Approval card: accept_for_session remembers command for this chat, and decline rejects file edit
    const requestedApprovals: Array<{ kind: string; command?: string; paths?: string[] }> = [];
    let nextDecision: ApprovalDecision = "accept_for_session";
    native.executor.approvals.connect(async (event) => {
      if (event.type === "approval") {
        requestedApprovals.push({ kind: event.approval.kind, command: event.approval.command, paths: event.approval.paths });
        queueMicrotask(() => native.executor.approvals.decide({
          sessionId: event.sessionId,
          turnId: event.turnId,
          approvalId: event.approval.id,
          decision: nextDecision,
        }));
      }
    });

    const cmdTurn1 = makeTurn(second.turnId, [{ type: "text", text: "need-cmd" }], { approvalMode: "inherit" });
    const cmdRes1 = await executeTurn(native.executor, cmdTurn1, () => {}, new AbortController().signal, null);
    assert.equal(requestedApprovals.length, 1);
    assert.equal(requestedApprovals[0]?.kind, "command");
    assert.equal(requestedApprovals[0]?.command, "echo hello");
    assert.match(String(cmdRes1.event.message.content[0]?.type === "text" ? cmdRes1.event.message.content[0].text : ""), /perm:allowed/);
    await settle(cmdTurn1, cmdRes1);

    // Second identical command reuses session grant without prompting again
    const cmdTurn2 = makeTurn(cmdTurn1.turnId, [{ type: "text", text: "need-cmd" }], { approvalMode: "inherit" });
    const cmdRes2 = await executeTurn(native.executor, cmdTurn2, () => {}, new AbortController().signal, null);
    assert.equal(requestedApprovals.length, 1);
    assert.match(String(cmdRes2.event.message.content[0]?.type === "text" ? cmdRes2.event.message.content[0].text : ""), /perm:allowed/);
    await settle(cmdTurn2, cmdRes2);

    // Decline file edit
    nextDecision = "decline";
    const editTurn = makeTurn(cmdTurn2.turnId, [{ type: "text", text: "need-edit" }], { approvalMode: "inherit" });
    const editRes = await executeTurn(native.executor, editTurn, () => {}, new AbortController().signal, null);
    assert.equal(requestedApprovals.length, 2);
    assert.equal(requestedApprovals[1]?.kind, "file_change");
    assert.deepEqual(requestedApprovals[1]?.paths, ["/workspace/a.ts"]);
    assert.match(String(editRes.event.message.content[0]?.type === "text" ? editRes.event.message.content[0].text : ""), /perm:edit-denied/);
    await settle(editTurn, editRes);

    // 4. Platform read-only mode denies permission without showing a card and rejects conflicting approvalMode
    const roSession = randomUUID();
    await assert.rejects(
      executeTurn(native.executor, makeTurn(null, [{ type: "text", text: "need-cmd" }], { sessionId: roSession, accessMode: "read_only", approvalMode: "full_access" }), () => {}, new AbortController().signal, null),
      /conflicts with read-only/,
    );
    const roTurn = makeTurn(null, [{ type: "text", text: "need-cmd" }], { sessionId: roSession, accessMode: "read_only" });
    const roRes = await executeTurn(native.executor, roTurn, () => {}, new AbortController().signal, null);
    assert.equal(requestedApprovals.length, 2);
    assert.match(String(roRes.event.message.content[0]?.type === "text" ? roRes.event.message.content[0].text : ""), /mode:plan .*perm:denied/);

    // 5. full_access passes --dangerously-skip-permissions
    const faTurn = makeTurn(null, [{ type: "text", text: "need-cmd" }], { sessionId: randomUUID(), approvalMode: "full_access" });
    const faRes = await executeTurn(native.executor, faTurn, () => {}, new AbortController().signal, null);
    assert.match(String(faRes.event.message.content[0]?.type === "text" ? faRes.event.message.content[0].text : ""), /perm:allowed skip:1/);

    // 6. Abort triggers session/cancel and settles as aborted
    const controller = new AbortController();
    const cancelTurn = makeTurn(null, [{ type: "text", text: "sleep:5000" }], { sessionId: randomUUID() });
    setTimeout(() => controller.abort(), 150);
    const cancelRes = await executeTurn(native.executor, cancelTurn, () => {}, controller.signal, null);
    assert.equal(cancelRes.event.message.stopReason, "aborted");
  } finally {
    await native.close();
  }
}));

test("Antigravity transcript reader resolves cwd via SQLite, filters subagents, pairs tool results and reads transcript_full.jsonl", () => withEnvironment(async (root) => {
  const project = join(root, "proj");
  await mkdir(project, { recursive: true });
  const appDataRoot = join(root, "gemini", "antigravity-cli");
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

  const userPath = antigravityTranscriptPath(userConv, "antigravity-cli");
  const childPath = antigravityTranscriptPath(childConv, "antigravity-cli");
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
}));

test("antigravity transcript matches secondary workspace_uris roots and reads WAL-mode SQLite databases", () => withEnvironment(async (root) => {
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  const repoC = join(root, "repo-c");
  await Promise.all([
    mkdir(repoA, { recursive: true }),
    mkdir(repoB, { recursive: true }),
    mkdir(repoC, { recursive: true }),
  ]);

  const appDataRoot = join(root, "gemini", "antigravity-cli");
  await mkdir(appDataRoot, { recursive: true });
  const convId = randomUUID();
  const db = new DatabaseSync(join(appDataRoot, "conversation_summaries.db"));
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, parent_conversation_id TEXT, nesting_depth INTEGER)");
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, '', 0)").run(
      convId,
      JSON.stringify([pathToFileURL(repoA).href, pathToFileURL(repoB).href, pathToFileURL(repoA).href]),
    );

    const transcriptPath = antigravityTranscriptPath(convId, "antigravity-cli");
    await mkdir(join(appDataRoot, "brain", convId, ".system_generated", "logs"), { recursive: true });
    await writeFile(transcriptPath, `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-21T02:00:00Z", content: "hi" })}\n`);

    // Keep WAL writer connection open while reading read-only.
    const header = await antigravitySessionHeader(transcriptPath);
    assert.deepEqual(header, {
      harness: "antigravity",
      nativeSessionId: convId,
      cwd: repoA,
      cwds: [repoB],
      thread: "user",
    });

    const foundInA = await discoverTranscripts(repoA, ["antigravity"], { headers: true });
    const foundInB = await discoverTranscripts(repoB, ["antigravity"], { headers: true });
    const foundInC = await discoverTranscripts(repoC, ["antigravity"], { headers: true });
    assert.deepEqual(foundInA.map((entry) => entry.nativeSessionId), [convId]);
    assert.deepEqual(foundInB.map((entry) => entry.nativeSessionId), [convId]);
    assert.deepEqual(foundInC, []);
  } finally {
    db.close();
  }
}));

test("Antigravity transcript clears stale result across background wakeups until final response settles", () => withEnvironment(async (root) => {
  const appDataRoot = join(root, "gemini", "antigravity-cli");
  const convId = randomUUID();
  const transcriptPath = antigravityTranscriptPath(convId, "antigravity-cli");
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
  const appDataRoot = join(root, "gemini", "antigravity-cli");
  const convId = randomUUID();
  const transcriptPath = antigravityTranscriptPath(convId, "antigravity-cli");
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
  const appDataRoot = join(root, "gemini", "antigravity-cli");
  const convId = randomUUID();
  const logsDir = join(appDataRoot, "brain", convId, ".system_generated", "logs");
  const transcriptPath = antigravityTranscriptPath(convId, "antigravity-cli");
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
