import assert from "node:assert/strict";
import test from "node:test";
import { resolveLlmRequestStats } from "./token-usage.js";

test("uses exact provider call outcomes for compaction usage", () => {
  assert.deepEqual(resolveLlmRequestStats({
    role: "system",
    stopReason: null,
    errorMessage: null,
    meta: {
      messageKind: "compacted",
      compaction: {
        providerCalls: { total: 3, succeeded: 2, failed: 1 },
      },
    },
  }), {
    requestCount: 3,
    successCount: 2,
    errorCount: 1,
  });
});

test("keeps legacy compaction call counts compatible", () => {
  assert.deepEqual(resolveLlmRequestStats({
    role: "system",
    meta: {
      messageKind: "compacted",
      compaction: { providerCallCount: 2 },
    },
  }), {
    requestCount: 2,
    successCount: 2,
    errorCount: 0,
  });
});

test("falls back safely for malformed provider call outcomes", () => {
  assert.deepEqual(resolveLlmRequestStats({
    role: "system",
    stopReason: "error",
    meta: {
      messageKind: "compacted",
      compaction: {
        providerCalls: { total: 3, succeeded: 3, failed: 1 },
      },
    },
  }), {
    requestCount: 1,
    successCount: 0,
    errorCount: 1,
  });
});

test("counts aborted assistant requests as errors", () => {
  assert.deepEqual(resolveLlmRequestStats({
    role: "assistant",
    stopReason: "aborted",
  }), {
    requestCount: 1,
    successCount: 0,
    errorCount: 1,
  });
});
