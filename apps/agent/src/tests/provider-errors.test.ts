import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableProviderError } from "../runtime/provider-errors.js";

const http2Error = "Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed";

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

test("keeps terminal errors terminal when they mention HTTP/2 failures", () => {
  for (const reason of ["insufficient_quota", "401 Unauthorized"]) {
    assert.equal(isRetryableProviderError(assistantError(`${reason}: ${http2Error}`)), false, reason);
  }
});
