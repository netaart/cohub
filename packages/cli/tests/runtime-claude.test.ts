import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
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

const binary = fileURLToPath(new URL("./fixtures/runtime-claude.mjs", import.meta.url));

test("Claude Code Turns carry Cohub history, attach tool results and resume natively", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-claude-"));
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  await chmod(binary, 0o755);
  const spaceId = randomUUID(), sessionId = randomUUID(), history = randomUUID();
  const source = runtimeProjectionSource();
  source.addTurn(sessionId, history, { userContent: [{ type: "text", text: "historical fact" }], assistantContent: [{ type: "text", text: "noted" }] });
  const stateRoot = join(root, "state");
  const diagnostics = new RuntimeDiagnostics({ root: stateRoot, spaceId });
  const native = new NativeRuntime({
    spaceId, root, stateRoot, harnesses: ["claude"], executables: { claude: binary }, identity: "test", config: null,
    archives: new RuntimeArchiveStore(join(stateRoot, "archives"), null), projectionSource: source, diagnostics,
  });
  const turn = (turnId: string, throughTurnId: string, accessMode: RuntimeTurnInput["accessMode"]): RuntimeTurnInput => ({
    spaceId, sessionId, turnId, userMessageId: turnId, harness: "claude", accessMode,
    messages: [{ turnId, userMessageId: turnId, userId: "author", content: [{ type: "text", text: "continue" }] }],
    context: { revision: randomUUID(), throughTurnId, messages: [] },
  });
  try {
    const events: RuntimeExecutionEvent[] = [];
    const first = turn(randomUUID(), history, "full_access");
    const result = await executeTurn(native.executor, first, (event) => events.push(event), new AbortController().signal, null);
    assert.equal(result.event.resume, "handoff");
    assert.deepEqual(result.event.message.content, [{ type: "text", text: "history retained acceptEdits" }]);
    const commit = events.find((event) => event.type === "message.commit");
    assert.deepEqual(commit?.type === "message.commit" && commit.message.content.map((block) => block.type), ["text", "tool_use", "tool_result"]);
    assert(!JSON.stringify(events).includes("sub-agent"), "sub-agent traffic stays native");
    await native.executor.results.record(result.session, first, null, [result.event]);
    await native.executor.results.acknowledge(sessionId, first.turnId);

    const second = await executeTurn(native.executor, turn(randomUUID(), first.turnId, "read_only"), () => {}, new AbortController().signal, null);
    assert.equal(second.event.resume, "native");
    assert.equal(second.session.path, result.session.path);
    assert.deepEqual(second.event.message.content, [{ type: "text", text: "history retained plan" }]);

    const skipped: string[] = [];
    const catalog = await discoverHarnesses(["claude", "workbuddy"], { claude: binary, workbuddy: join(root, "missing") }, root, (harness) => skipped.push(harness));
    assert.deepEqual([catalog.harnesses, skipped], [["claude"], ["workbuddy"]]);
    await assert.rejects(discoverHarnesses(["claude", "workbuddy"], { claude: binary, workbuddy: join(root, "missing") }, root));
  } finally {
    await native.close(AbortSignal.timeout(2_000));
    await diagnostics.close();
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});
