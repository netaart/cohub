import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { LocalHarness, RuntimeExecutionEvent, RuntimeTurnInput } from "@neta-art/cohub";
import { resolveRuntimeThinkingLevel } from "@cohub/protocol";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { RuntimeDiagnostics } from "../src/runtime/diagnostics.js";
import { NativeRuntime } from "../src/runtime/native/daemon.js";
import { executeTurn } from "../src/runtime/native/execution.js";
import { discoverHarnesses, refreshHarnesses } from "../src/runtime/harnesses/index.js";
import { claudeProjectName } from "../src/runtime/harnesses/claude.js";
import { workbuddyProjectName } from "../src/runtime/harnesses/workbuddy.js";
import { runtimeProjectionSource } from "./fixtures/runtime-projection-source.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";

const fixture = fileURLToPath(new URL("./fixtures/runtime-stream-json.mjs", import.meta.url));
const ENV = ["CLAUDE_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "PATH", "STREAM_JSON_FIXTURE_HELP"] as const;

async function streamJsonTurns(harness: Extract<LocalHarness, "claude" | "workbuddy">, binary: string) {
  const root = await mkdtemp(join(tmpdir(), `cohub-${harness}-`));
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEBUDDY_CONFIG_DIR;
  process.env[harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEBUDDY_CONFIG_DIR"] = join(root, "config");
  // The executable is found on PATH under its real name, as with a default install.
  await chmod(fixture, 0o755);
  await mkdir(join(root, "bin"));
  await symlink(fixture, join(root, "bin", binary));
  process.env.PATH = `${join(root, "bin")}:${previous.PATH ?? ""}`;
  const spaceId = randomUUID(), sessionId = randomUUID(), history = randomUUID();
  const source = runtimeProjectionSource();
  source.addTurn(sessionId, history, { userContent: [{ type: "text", text: "historical fact" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGlzdG9yaWNhbCBpbWFnZQ==" } }], assistantContent: [{ type: "text", text: "noted" }] });
  const storage = await archiveStorageFixture();
  const errors: string[] = [];
  const runtimes: { native: NativeRuntime; diagnostics: RuntimeDiagnostics }[] = [];
  const runtime = (stateRoot: string) => {
    const diagnostics = new RuntimeDiagnostics({ root: stateRoot, spaceId });
    const log = diagnostics.log.bind(diagnostics);
    diagnostics.log = (level, event, ...rest) => { if (level === "error") errors.push(event); return log(level, event, ...rest); };
    const native = new NativeRuntime({
      spaceId, root, stateRoot, harnesses: [harness], executables: {}, identity: "test", config: null,
      archives: new RuntimeArchiveStore(join(stateRoot, "archives"), storage.transport), projectionSource: source, diagnostics,
    });
    runtimes.push({ native, diagnostics });
    return native;
  };
  const native = runtime(join(root, "state"));
  type TurnOptions = { access?: RuntimeTurnInput["accessMode"]; archive?: RuntimeTurnInput["context"]["archive"]; prompt?: string; session?: string } & Pick<RuntimeTurnInput, "model" | "thinkingLevel">;
  const turn = (throughTurnId: string, { access = "full_access", archive, prompt = "continue", session = sessionId, ...model }: TurnOptions = {}): RuntimeTurnInput => {
    const turnId = randomUUID();
    return {
      spaceId, sessionId: session, turnId, userMessageId: turnId, harness, accessMode: access, ...model,
      messages: [{ turnId, userMessageId: turnId, userId: "author", content: [{ type: "text", text: prompt }] }],
      context: { revision: randomUUID(), throughTurnId, messages: [], ...(archive ? { archive } : {}) },
    };
  };
  try {
    const events: RuntimeExecutionEvent[] = [];
    const first = turn(history);
    const result = await executeTurn(native.executor, first, (event) => events.push(event), new AbortController().signal, null);
    assert.equal(result.event.resume, "handoff");
    assert.deepEqual(result.event.message.content, [{ type: "text", text: "history retained acceptEdits" }]);
    const commit = events.find((event) => event.type === "message.commit");
    assert.deepEqual(commit?.type === "message.commit" && commit.message.content.map((block) => block.type), ["text", "tool_use", "tool_result"]);
    assert(!JSON.stringify(events).includes("sub-agent"), "sub-agent traffic stays native");
    await native.executor.results.record(result.session, first, null, [result.event]);
    await native.executor.results.acknowledge(sessionId, first.turnId);

    const secondInput = turn(first.turnId, { access: "read_only" });
    const second = await executeTurn(native.executor, secondInput, () => {}, new AbortController().signal, null);
    assert.equal(second.event.resume, "native");
    assert.equal(second.session.path, result.session.path);
    assert.deepEqual(second.event.message.content, [{ type: "text", text: "history retained plan tools:Read,Glob,Grep no-mcp" }]);
    await native.executor.archives.flush(new AbortController().signal);

    // A cold Runtime restores the archive beside the original file, which stays untouched.
    const original = await readFile(second.session.path);
    assert(second.event.archive);
    const cold = runtime(join(root, "cold"));
    const restoredInput = turn(secondInput.turnId, { archive: second.event.archive });
    const restored = await executeTurn(cold.executor, restoredInput, () => {}, new AbortController().signal, null);
    assert.equal(restored.event.resume, "restored");
    assert.notEqual(restored.session.path, second.session.path);
    assert.deepEqual(restored.event.message.content, [{ type: "text", text: "history retained acceptEdits" }]);
    assert.deepEqual(await readFile(second.session.path), original);
    const ids = new Set((await readFile(restored.session.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line).sessionId));
    assert.deepEqual([...ids], [restored.session.nativeSessionId]);
    assert.deepEqual(errors, [], "a normal exit is not a failure");

    // Text streamed before the CLI died is kept in the durable result.
    await cold.executor.results.record(restored.session, restoredInput, null, [restored.event]);
    await cold.executor.results.acknowledge(sessionId, restoredInput.turnId);
    const crashed = await executeTurn(cold.executor, turn(restoredInput.turnId, { prompt: "crash" }), () => {}, new AbortController().signal, null);
    assert.equal(crashed.event.message.stopReason, "error");
    assert.deepEqual(crashed.event.message.content, [{ type: "text", text: "partial reply" }]);

    // History that projects to nothing starts a new session; the default model passes no --model.
    const empty = randomUUID(), emptyHistory = randomUUID();
    source.addTurn(empty, emptyHistory, { userContent: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }], assistantContent: [] });
    const fresh = await executeTurn(cold.executor, turn(emptyHistory, { session: empty, model: "default", thinkingLevel: "ultra" }), () => {}, new AbortController().signal, null);
    assert.equal(fresh.event.resume, "new");
    assert.deepEqual(fresh.event.message.content, [{ type: "text", text: "no history acceptEdits effort:ultra" }]);

    // A stop interrupts the CLI and is not reported as an error.
    const stop = new AbortController();
    const stopped = await executeTurn(cold.executor, turn(randomUUID(), { session: randomUUID(), prompt: "wait" }), (event) => { if (event.type === "text.delta") stop.abort(); }, stop.signal, null);
    assert.deepEqual([stopped.event.message.stopReason, stopped.event.message.errorMessage], ["aborted", null]);
    assert.deepEqual(stopped.event.message.content, [{ type: "text", text: "partial reply" }]);
  } finally {
    for (const { native, diagnostics } of runtimes) { await native.close(AbortSignal.timeout(2_000)); await diagnostics.close(); }
    for (const key of ENV) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
    await storage.close();
  }
}

test("Claude Code Turns carry Cohub history, attach tool results and resume natively", () => streamJsonTurns("claude", "claude"));
test("WorkBuddy Turns run codebuddy, carry Cohub history and resume natively", () => streamJsonTurns("workbuddy", "codebuddy"));

test("discovery checks the CLI, lists models with a default and skips unusable harnesses when asked", async () => {
  const previous = process.env.STREAM_JSON_FIXTURE_HELP;
  try {
    const missing = join(tmpdir(), randomUUID());
    const skipped: string[] = [];
    const catalog = await discoverHarnesses(["claude", "workbuddy"], { claude: missing, workbuddy: fixture }, tmpdir(), (harness) => skipped.push(harness));
    assert.deepEqual([catalog.harnesses, catalog.models.map((model) => model.id), skipped], [["workbuddy"], ["default", "fixture-a", "fixture-b"], ["claude"]]);
    assert.deepEqual([catalog.models[0]?.isDefault, catalog.models[0]?.reasoning, catalog.models[0]?.thinkingLevelMap?.off, catalog.models[0]?.thinkingLevelMap?.max], [true, true, null, "max"]);
    await assert.rejects(discoverHarnesses(["claude", "workbuddy"], { claude: missing, workbuddy: fixture }, tmpdir()));
    const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://gateway.example.com/v1";
    const claude = await discoverHarnesses(["claude"], { claude: fixture }, tmpdir()).finally(() => {
      if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    });
    assert.deepEqual(claude.models.map((model) => [model.id, model.provider, model.isDefault ?? false, model.thinkingLevelMap?.high]), [["default", "anthropic", true, "high"], ["opus", "anthropic", false, "high"], ["gw-model", "gateway.example.com", false, undefined]]);
    // A level the CLI lists for a model is offered beyond the profile's fallback levels; a model without effort runs `off`.
    assert.equal(claude.models[0]?.thinkingLevelMap?.ultra, "ultra");
    assert.equal(resolveRuntimeThinkingLevel(claude.models[2], "ultra"), "off");
    process.env.STREAM_JSON_FIXTURE_HELP = "no-initialize";
    // A refresh keeps the discovered catalog rather than falling back to the aliases.
    const failures: string[] = [];
    assert.deepEqual(await refreshHarnesses(claude, { claude: fixture }, tmpdir(), (harness) => failures.push(harness)), claude);
    assert.deepEqual(failures, ["claude"]);
    const aliases = await discoverHarnesses(["claude"], { claude: fixture }, tmpdir());
    assert.deepEqual(aliases.models.map((model) => [model.id, model.isDefault ?? false, model.thinkingLevelMap?.minimal]), [["default", true, null], ["opus", false, null], ["sonnet", false, null], ["haiku", false, undefined]]);
    process.env.STREAM_JSON_FIXTURE_HELP = "legacy";
    await assert.rejects(discoverHarnesses(["claude"], { claude: fixture }, tmpdir()), /missing --tools/);
    process.env.STREAM_JSON_FIXTURE_HELP = "no-models";
    await assert.rejects(discoverHarnesses(["workbuddy"], { workbuddy: fixture }, tmpdir()), /lists no models/);
  } finally {
    if (previous === undefined) delete process.env.STREAM_JSON_FIXTURE_HELP; else process.env.STREAM_JSON_FIXTURE_HELP = previous;
  }
});

test("project directories match the names Claude Code and CodeBuddy give long paths", () => {
  // Expected names were produced by claude 2.1.303 and codebuddy 2.169.0 in this directory.
  const long = `/tmp/agents/long/${"a".repeat(120)}/${"b".repeat(120)}`;
  assert.equal(claudeProjectName(long), `${long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-nrp22e`);
  assert.equal(workbuddyProjectName(long), `${long.slice(1).replaceAll("/", "-").slice(0, 180)}-279wfg`);
  assert.equal(claudeProjectName("/tmp/a.b"), "-tmp-a-b");
});
