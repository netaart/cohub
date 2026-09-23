import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  readRuntimeDiagnosticEvents,
  RuntimeDiagnosticReader,
  RuntimeDiagnostics,
  serializeDiagnosticError,
} from "../src/runtime/diagnostics.js";

const spaceId = "11111111-1111-4111-8111-111111111111";
const runtimeId = "22222222-2222-4222-8222-222222222222";

test("Runtime diagnostics persist ordered, redacted JSONL events", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-diagnostics-"));
  try {
    const diagnostics = new RuntimeDiagnostics({ root, spaceId, runtimeId });
    diagnostics.log("error", "runtime.websocket.error", {
      token: "do-not-store",
      url: "https://gateway.example.test/ws?token=do-not-store&attempt=2",
      nested: { authorization: "also-secret" },
      error: { message: "connection failed", code: "ENOTFOUND" },
    }, { requestId: "request-1" });
    await diagnostics.close();

    const events = await readRuntimeDiagnosticEvents(root, { limit: 10 });
    assert.equal(events.length, 1);
    const stored = events[0];
    assert(stored);
    assert.equal(stored.sequence, 0);
    assert.equal(stored.traceContext?.requestId, "request-1");
    assert.equal(stored.data?.token, "[REDACTED]");
    assert.match(String(stored.data?.url), /token=\[REDACTED\]/);
    assert.deepEqual(stored.data?.nested, { authorization: "[REDACTED]" });
    assert.deepEqual(stored.error, { message: "connection failed", code: "ENOTFOUND" });
    assert.equal(stored.data?.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental diagnostics reader never loses bursts beyond the display limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-diagnostics-follow-"));
  try {
    const diagnostics = new RuntimeDiagnostics({ root, spaceId, runtimeId, logFlushIntervalMs: 5 });
    for (let sequence = 0; sequence < 5; sequence += 1) diagnostics.log("info", "fixture", { sequence });
    const initialDeadline = Date.now() + 2_000;
    while ((await readRuntimeDiagnosticEvents(root)).length < 5 && Date.now() < initialDeadline) await delay(10);

    const reader = new RuntimeDiagnosticReader(root);
    assert.deepEqual((await reader.read({ limit: 2 })).map((event) => event.sequence), [3, 4]);

    for (let sequence = 5; sequence < 25; sequence += 1) diagnostics.log("info", "fixture", { sequence });
    const burst: number[] = [];
    const deadline = Date.now() + 2_000;
    while (burst.length < 20 && Date.now() < deadline) {
      burst.push(...(await reader.read({ limit: 2 })).map((event) => event.sequence));
      if (burst.length < 20) await delay(10);
    }
    assert.deepEqual(
      burst,
      Array.from({ length: 20 }, (_, index) => index + 5),
    );
    await diagnostics.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime diagnostics rotate bounded local files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-diagnostics-rotate-"));
  try {
    const diagnostics = new RuntimeDiagnostics({
      root,
      spaceId,
      runtimeId,
      maxLogFileBytes: 512,
      maxTotalLogBytes: 2_048,
    });
    for (let index = 0; index < 20; index += 1) {
      diagnostics.log("error", "fixture", { index, message: "x".repeat(160) });
    }
    await diagnostics.close();
    const files = (await readdir(diagnostics.directory)).filter((name) => name.endsWith(".jsonl"));
    assert(files.length > 1);
    assert(files.length < 20, "capacity pruning must prevent unbounded file growth");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Diagnostic errors retain useful network fields", () => {
  const error = Object.assign(new Error("fetch failed"), {
    code: "ENOTFOUND",
    hostname: "gateway.example.test",
    syscall: "getaddrinfo",
  });
  assert.deepEqual(serializeDiagnosticError(error), {
    name: "Error",
    message: "fetch failed",
    stack: error.stack,
    code: "ENOTFOUND",
    syscall: "getaddrinfo",
    hostname: "gateway.example.test",
  });
});
