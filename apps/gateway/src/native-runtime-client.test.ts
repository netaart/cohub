import assert from "node:assert/strict";
import { test } from "node:test";
process.env.API_BASE_URL = "http://native.invalid/api";
process.env.WORKER_SECRET = "worker-test";
const { forwardNativeRuntimeEvent } = await import("./native-runtime-client.js");

const apiBaseUrl = "http://native.invalid/api";
const headers = { "content-type": "application/json", "x-worker-secret": "worker-test" };

const input = { spaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "owner", requestId: "22222222-2222-4222-8222-222222222222", event: { type: "known" as const, input: { turnIds: ["22222222-2222-4222-8222-222222222222"] } } };

test("native forwarding preserves the exact request, result, and 120 second cancellation deadline", async (t) => {
  let captured: RequestInit | undefined;
  let url: unknown;
  const signal = new AbortController().signal;
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => { deadlines.push(ms); return signal; });
  t.mock.method(globalThis, "fetch", async (target: unknown, options: RequestInit) => { url = target; captured = options; return Response.json({ result: { turns: [{ turnId: input.requestId, settled: true }] } }); });
  const result = await forwardNativeRuntimeEvent(input);
  assert.deepEqual(result, { turns: [{ turnId: input.requestId, settled: true }] });
  assert.equal(url, `${apiBaseUrl}/internal/gateway/native-runtime-event`);
  assert.equal(captured?.method, "POST");
  assert.deepEqual(JSON.parse(String(captured?.body)), input);
  const sentHeaders = new Headers(captured?.headers);
  for (const [name, value] of Object.entries(headers)) assert.equal(sentHeaders.get(name), value);
  assert.match(sentHeaders.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(deadlines, [120_000]);
  assert.equal(captured?.signal, signal);
});

test("malformed JSON and missing result never fabricate an accepted response", async (t) => {
  for (const body of ["not JSON", "null", "[]", "{}", '{"accepted":true}']) {
    const fake = t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 200 }));
    await assert.rejects(forwardNativeRuntimeEvent(input), (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /native runtime.*(JSON|result|response)/i);
      if (body === "not JSON") assert(error.cause instanceof SyntaxError);
      return true;
    });
    fake.mock.restore();
  }
});

test("explicit null and false results are returned exactly as provided", async (t) => {
  for (const result of [null, false, 0]) {
    const fake = t.mock.method(globalThis, "fetch", async () => Response.json({ result }));
    assert.equal(await forwardNativeRuntimeEvent(input), result);
    fake.mock.restore();
  }
});

test("upstream rejection reports both the original HTTP status and message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "Parent Turn is not recorded" }, { status: 409 }));
  await assert.rejects(forwardNativeRuntimeEvent(input), (error: unknown) => error instanceof Error && /409/.test(error.message) && /Parent Turn is not recorded/.test(error.message));
});

test("forwarding propagates an aborted upstream operation without manufacturing a result", async (t) => {
  const controller = new AbortController();
  const reason = new DOMException("Native upstream deadline", "TimeoutError");
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    assert.equal(options.signal, controller.signal);
    controller.abort(reason);
    options.signal?.throwIfAborted();
    throw new Error("Expected deadline to abort the request");
  });
  await assert.rejects(forwardNativeRuntimeEvent(input), (error: unknown) => error === reason);
});
