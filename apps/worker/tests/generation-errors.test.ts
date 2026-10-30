import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GenerationProviderError,
  GenerationTimeoutError,
  GenerationValidationError,
} from "@neta-art/generation";
import { normalizeGenerationError } from "../src/tasks/generation-errors.js";

const upstreamMessage =
  "The upstream service timed out. Please try again later. (request id: 20261030170932480443795qqe4celQ)";

test("keeps provider ids, urls and raw bodies out of upstream failures", () => {
  const upstreamBody = JSON.stringify({
    error: { message: upstreamMessage, type: "server_error", code: "" },
    request_id: "upstream-request-1",
    upstream_url: "https://api.openlux.ai/v1/images/edits",
  });
  const gatewayBody = JSON.stringify({
    error: { message: upstreamBody, type: "upstream_error", code: "bad_response_status_code" },
    new_api: {
      request_id: "router-request-1",
      upstream_request_id: "newapi-request-1",
      upstream_url: "https://api.openlux.ai/v1/images/edits",
      upstream_response_body: upstreamBody,
    },
  });

  const error = normalizeGenerationError(
    new GenerationProviderError("Image edit provider request failed", { status: 504, body: gatewayBody }),
  );

  assert.equal(error.message, "The upstream service timed out. Please try again later. — HTTP 504");
});

test("hides log-shaped diagnostics instead of showing the raw body", () => {
  const body =
    "newapi_status=504, response_code=, origin=upstream, stage=upstream_response, upstream_status=504, upstream_url=https://api.openlux.ai/v1/images/edits, upstream_message=" +
    upstreamMessage;

  const error = normalizeGenerationError(
    new GenerationProviderError("Image edit provider request failed", { status: 504, body }),
  );

  assert.equal(error.message, "Generation provider is temporarily unavailable — HTTP 504");
});

test("keeps a provider explanation while dropping its request id", () => {
  const body = JSON.stringify({
    error: {
      message:
        "The provided prompt is considered unsafe and it cannot be used to generate content. (request id: 202610151726106713602428268d9d6BcXv2vkg)",
      code: "ERR-09201A6885",
    },
  });

  const error = normalizeGenerationError(
    new GenerationProviderError("Image generation provider request failed", { status: 400, body }),
  );

  assert.equal(
    error.message,
    "The provided prompt is considered unsafe and it cannot be used to generate content. — HTTP 400",
  );
});

test("reports credential and rate-limit failures without provider text", () => {
  const body = JSON.stringify({ error: { message: "key sk-secret rejected for account 42" } });

  assert.equal(
    normalizeGenerationError(new GenerationProviderError("failed", { status: 401, body })).message,
    "Generation provider rejected the configured credentials — HTTP 401",
  );
  assert.equal(
    normalizeGenerationError(new GenerationProviderError("failed", { status: 429, body })).message,
    "Generation provider rate limit exceeded — HTTP 429",
  );
});

test("falls back to a status message when the body is an HTML error page", () => {
  const body = "<html><body>502 Bad Gateway</body></html>";

  assert.equal(
    normalizeGenerationError(new GenerationProviderError("failed", { status: 502, body })).message,
    "Generation provider is temporarily unavailable — HTTP 502",
  );
});

test("distinguishes timeouts from other provider failures", () => {
  assert.equal(
    normalizeGenerationError(new GenerationTimeoutError()).message,
    "Generation request timed out",
  );
  assert.equal(
    normalizeGenerationError(new GenerationProviderError("Generation transport failed host=api.openlux.ai path=/v1/images/edits")).message,
    "Generation provider request failed",
  );
});

test("keeps validation errors and plain errors unchanged", () => {
  assert.equal(
    normalizeGenerationError(new GenerationValidationError("prompt is required")).message,
    "Invalid generation input: prompt is required",
  );
  assert.equal(normalizeGenerationError(new Error("worker stopped")).message, "worker stopped");
});
