import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableProviderError } from "../runtime/provider-errors.js";

const http2Error = "Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed";
const replayBlockedError = "upstream_replay_blocked: Upstream response stopped after protected output or tool activity; automatic replay is not allowed.";

function assistantError(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "cohub",
    model: "gpt-5",
    content: [],
    stopReason: "error",
    errorMessage,
    timestamp: 0,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("retries upstream HTTP/2 stream failures", () => {
  for (const errorMessage of [http2Error, "upstream_http2_stream_error", "Upstream HTTP/2 stream failed"]) {
    assert.equal(isRetryableProviderError(assistantError(errorMessage)), true, errorMessage);
  }
});

test("classifies blocked upstream replays as retryable", () => {
  for (const errorMessage of ["upstream_replay_blocked", replayBlockedError, `Error Code ${replayBlockedError}`]) {
    const message = assistantError(errorMessage);
    message.content = [{ type: "text", text: "Checking the current file." }];
    assert.equal(isRetryableProviderError(message), true, errorMessage);
    message.stopReason = "aborted";
    assert.equal(isRetryableProviderError(message), false, errorMessage);
  }
});

test("keeps terminal errors terminal when they mention upstream failures", () => {
  for (const reason of ["insufficient_quota", "401 Unauthorized", "403 Forbidden", "invalid request"]) {
    for (const errorMessage of [http2Error, replayBlockedError]) {
      assert.equal(isRetryableProviderError(assistantError(`${reason}: ${errorMessage}`)), false, `${reason}: ${errorMessage}`);
    }
  }
});
