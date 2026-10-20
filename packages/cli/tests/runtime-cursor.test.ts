import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
import { runtimeProjectionSource } from "./fixtures/runtime-projection-source.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";

const fixture = fileURLToPath(new URL("./fixtures/runtime-cursor.mjs", import.meta.url));
const ENV = ["CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "CURSOR_FIXTURE", "PATH"] as const;

async function withEnvironment(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cohub-cursor-"));
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  process.env.CURSOR_CONFIG_DIR = join(root, "config");
  process.env.CURSOR_DATA_DIR = join(root, "data");
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
