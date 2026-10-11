import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableProviderError, isRetryableProviderErrorMessage } from "../runtime/provider-errors.js";

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

for (const errorMessage of [
  http2Error,
  "upstream_http2_stream_error",
  "Upstream HTTP/2 stream failed",
  "UPSTREAM_HTTP2_STREAM_ERROR",
  "upstream http/2 STREAM FAILED",
]) {
  test(`retries HTTP/2 transport failure: ${errorMessage}`, () => {
    assert.equal(isRetryableProviderErrorMessage(errorMessage), true);
    assert.equal(isRetryableProviderError(assistantError(errorMessage)), true);
  });
}

for (const reason of [
  "insufficient_quota", "insufficient_user_quota", "quota exceeded", "out of budget",
  "billing", "余额不足", "额度不足", "invalid request", "invalid url", "content_filter",
  "request too large", "payload too large", "model unavailable",
  "400 Bad Request", "401 Unauthorized", "403 Forbidden", "404 Not Found", "422 Unprocessable Entity",
]) {
  test(`preserves terminal classification for ${reason}`, () => {
    const errorMessage = `${reason}: ${http2Error}`;
    assert.equal(isRetryableProviderErrorMessage(errorMessage), false);
    assert.equal(isRetryableProviderError(assistantError(errorMessage)), false);
  });
}

for (const errorMessage of [
  "responses_missing_terminal", "anthropic_missing_message_stop", "stream_read_error",
  "upstream_temporarily_unavailable", "stream ended before a terminal response event",
  "upstream service temporarily unavailable", "upstream request failed",
  "400 upstream_error: upstream request failed", "408", "413", "429", "500", "502", "503", "504",
]) {
  test(`preserves existing retry classification for ${errorMessage}`, () => {
    assert.equal(isRetryableProviderErrorMessage(errorMessage), true);
    assert.equal(isRetryableProviderError(assistantError(errorMessage)), true);
  });
}

test("retains pi-ai classification for other transport errors", () => {
  assert.equal(isRetryableProviderError(assistantError("socket hang up")), true);
  assert.equal(isRetryableProviderError(assistantError("fetch failed")), true);
  assert.equal(isRetryableProviderError(assistantError("unknown error")), false);
});

test("does not retry successful or cancelled assistant messages", () => {
  for (const stopReason of ["stop", "length", "toolUse", "aborted"] as const) {
    assert.equal(isRetryableProviderError({ ...assistantError(http2Error), stopReason }), false);
  }
  assert.equal(isRetryableProviderError(undefined), false);
  assert.equal(isRetryableProviderError(assistantError("")), false);
  assert.equal(isRetryableProviderErrorMessage(""), false);
});

test("classifies a failed partial reply without changing its content", () => {
  const message = assistantError(http2Error);
  message.content = [
    { type: "text", text: "Partial response" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
  ];
  const before = structuredClone(message);
  assert.equal(isRetryableProviderError(message), true);
  assert.deepEqual(message, before);
});
