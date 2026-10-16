import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import { executeTurn } from "../src/runtime/native/execution.js";
import { testNativeRuntime } from "./fixtures/runtime-native.js";

test("Codex turn/start preserves Fast on, explicit off and omission while resuming", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-fast-"));
  const spaceId = randomUUID(), sessionId = randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  try {
    let previousTurnId: string | null = null;
    let nativeSessionId: string | null = null;
    const observed: Array<Record<string, unknown>> = [];
    for (const selection of [{ serviceTier: "priority" }, {}, { serviceTier: null }] as const) {
      const turnId = randomUUID();
      const input: RuntimeTurnInput = {
        spaceId, sessionId, turnId, userMessageId: turnId, harness: "codex", accessMode: "full_access", ...selection,
        messages: [{ turnId, userMessageId: turnId, userId: "author", content: [{ type: "text", text: "continue" }] }],
        context: { revision: turnId, throughTurnId: previousTurnId, messages: [] },
      };
      const result = await executeTurn(runtime.native.executor, input, () => {}, new AbortController().signal, turnId);
      assert.equal(result.event.message.stopReason, "stop");
      if (nativeSessionId) {
        assert.equal(result.session.nativeSessionId, nativeSessionId);
        assert.equal(result.event.resume, "native");
      }
      nativeSessionId = result.session.nativeSessionId;
      const rows = (await readFile(result.session.path, "utf8")).trim().split("\n").map((row) => JSON.parse(row));
      observed.push(rows.findLast((row) => row.type === "turn_context").payload);
      await runtime.native.executor.results.record(result.session, input, turnId, [result.event]);
      await runtime.native.executor.results.acknowledge(sessionId, turnId);
      previousTurnId = turnId;
    }
    assert.deepEqual(observed, [{ serviceTier: "priority" }, {}, { serviceTier: null }]);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
