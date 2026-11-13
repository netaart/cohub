import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AGENT_RETRY_MAX_RETRIES, getAssistantRetryOutcome, waitRetryBackoff } from "../runtime/assistant-retry.js";

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "cohub",
    model: "gpt-5",
    content: [],
    stopReason: "error",
    timestamp: 0,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}

const unavailable = assistantMessage({
  errorMessage: "503 Service Unavailable: upstream provider is temporarily unavailable, please try again later",
});

test("backs off across a multi-minute upstream outage before giving up", () => {
  const delays: number[] = [];
  let retryAttempt = 0;
  for (;;) {
    const outcome = getAssistantRetryOutcome(unavailable, retryAttempt);
    if (!outcome.shouldRetry) {
      assert.equal(outcome.retryReason, "retry_exhausted");
      break;
    }
    delays.push(outcome.retryDelayMs ?? Number.NaN);
    retryAttempt = outcome.retryAttempt;
  }
  assert.equal(AGENT_RETRY_MAX_RETRIES, 6);
  assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
});

test("does not retry terminal or aborted failures", () => {
  const quota = assistantMessage({ errorMessage: "insufficient_quota: 503 upstream unavailable" });
  assert.equal(getAssistantRetryOutcome(quota, 0).shouldRetry, false);
  assert.equal(getAssistantRetryOutcome(quota, 0).retryReason, "not_retryable");

  const aborted = assistantMessage({ stopReason: "aborted", errorMessage: "503 Service Unavailable" });
  assert.equal(getAssistantRetryOutcome(aborted, 0).shouldRetry, false);
});

test("aborting the backoff ends the wait immediately", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const waiting = waitRetryBackoff(60_000, controller.signal);
  controller.abort();
  await waiting;
  assert.ok(performance.now() - started < 1_000);
});

test("retries an empty successful assistant message with the same backoff", () => {
  const empty = assistantMessage({ stopReason: "stop", errorMessage: undefined });
  const outcome = getAssistantRetryOutcome(empty, 0);
  assert.equal(outcome.shouldRetry, true);
  assert.equal(outcome.retryDelayMs, 2_000);
  assert.equal(outcome.retryReason, "empty_assistant_message");
});
