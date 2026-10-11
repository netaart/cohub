import assert from "node:assert/strict";
import { test } from "node:test";
import { createGenerationClient, GenerationValidationError } from "@neta-art/generation";
import { GenerationTaskFailure, normalizeGenerationError } from "../src/tasks/generation-errors.js";

const routerId = "1d1615ae-c222-40a9-abdb-dc64050e3e9b";
const upstreamId = "202610110152305146F377600FB917788B";

function routerErrorFetch(): typeof fetch {
  // Long provider messages push the ids past the 500-character body preview.
  const message = `certificate has expired: ${"https://public.cohub.run/sessions/a.png ".repeat(30)}`;
  return (async () =>
    new Response(
      JSON.stringify({
        error: { message, type: "upstream_error" },
        new_api: { request_id: routerId, request_ids: [routerId], upstream_request_id: upstreamId, upstream_request_ids: [upstreamId] },
      }),
      { status: 500, headers: { "content-type": "application/json", "x-request-id": routerId } },
    )) as typeof fetch;
}

async function providerFailure(): Promise<unknown> {
  const client = createGenerationClient({ apiKey: "key", fetch: routerErrorFetch() });
  return client
    .generateResult({ model: "gpt-image-2", content: [{ type: "text", text: "hello" }] })
    .then(() => assert.fail("generation should fail"), (error: unknown) => error);
}

test("provider failures keep request ids that the message preview truncates", async () => {
  const normalized = normalizeGenerationError(await providerFailure());

  assert.ok(normalized instanceof GenerationTaskFailure);
  assert.deepEqual(normalized.result, { requestId: routerId, upstreamRequestIds: [upstreamId] });
  assert.match(normalized.message, /^Generation provider is temporarily unavailable — HTTP 500 — /);
  assert.equal(normalized.message.includes(routerId), false);
});

test("non-provider failures carry no task run result", () => {
  const normalized = normalizeGenerationError(new GenerationValidationError("bad size"));

  assert.equal(normalized instanceof GenerationTaskFailure, false);
  assert.equal(normalized.message, "Invalid generation input: bad size");
});
