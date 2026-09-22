import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";

const status = {
  protocolVersion: 1, family: "business.documents", generation: "g1", schemaVersion: 1,
  state: "ready", coverage: "complete", documentCount: 1, sourceCursor: "one",
};
let reply: { status: number; body: string; hang?: boolean };
const requests: Array<{ options: RequestOptions; body: unknown }> = [];

mock.module("node:http", {
  exports: {
    request(options: RequestOptions, callback: (response: PassThrough & { statusCode: number }) => void) {
      const req = new EventEmitter() as EventEmitter & { end(body?: Buffer): void; destroy(error: Error): void };
      req.destroy = (error) => { queueMicrotask(() => req.emit("error", error)); };
      req.end = (body) => {
        requests.push({ options, body: body ? JSON.parse(body.toString()) : undefined });
        const abort = () => req.destroy(new Error("aborted"));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        if (reply.hang) return;
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), { statusCode: reply.status });
          callback(response);
          response.end(reply.body);
          options.signal?.removeEventListener("abort", abort);
        });
      };
      return req;
    },
  },
});

const { SearchIndexClient, SearchIndexError } = await import("./search-client.js");

test("document client preserves arbitrary types, string fields and cursor preconditions", async () => {
  const client = new SearchIndexClient("/tmp/private/search.sock");
  reply = { status: 200, body: JSON.stringify(status) };
  const batch = {
    expectedCursor: null, cursor: "one", coverage: "complete" as const,
    changes: [{ operation: "upsert" as const, document: { type: "future.custom", spaceId: "s", id: "1" }, fields: { title: "字符串内容" } }],
  };
  assert.deepEqual(await client.apply(batch), status);
  const sent = requests.at(-1);
  assert.equal(sent?.options.socketPath, "/tmp/private/search.sock");
  assert.equal(sent?.options.path, "/documents/apply");
  assert.deepEqual(sent?.body, batch);
});

test("status and queries use the document protocol", async () => {
  const client = new SearchIndexClient("/tmp/private/search.sock");
  reply = { status: 200, body: JSON.stringify(status) };
  await client.status();
  assert.equal(requests.at(-1)?.options.method, "GET");
  assert.equal(requests.at(-1)?.options.path, "/status");
  const result = { ...status, hits: [], truncated: false, snapshot: "snapshot" };
  reply = { status: 200, body: JSON.stringify(result) };
  const query = { terms: [{ field: "title", value: "search" }], limit: 20 };
  assert.deepEqual(await client.query(query), result);
  assert.equal(requests.at(-1)?.options.path, "/query");
  assert.deepEqual(requests.at(-1)?.body, query);
});

test("cursor conflicts propagate with status 409 and are not retried", async () => {
  const client = new SearchIndexClient("/tmp/private/search.sock");
  reply = { status: 409, body: '{"error":"source cursor conflict"}' };
  const count = requests.length;
  await assert.rejects(client.apply({ expectedCursor: "old", cursor: "new", changes: [], coverage: "complete" }), (error: unknown) => {
    assert.ok(error instanceof SearchIndexError);
    assert.equal(error.status, 409);
    assert.match(error.message, /cursor conflict/);
    return true;
  });
  assert.equal(requests.length, count + 1);
});

test("client rejects an incompatible binary and malformed responses", async () => {
  const client = new SearchIndexClient("/tmp/private/search.sock");
  reply = { status: 200, body: '{"protocolVersion":99}' };
  await assert.rejects(client.status(), /Incompatible/);
  reply = { status: 200, body: "invalid JSON" };
  await assert.rejects(client.status(), SyntaxError);
});

test("caller cancellation stops a pending request", async () => {
  const client = new SearchIndexClient("/tmp/private/search.sock");
  reply = { status: 200, body: "", hang: true };
  const controller = new AbortController();
  const pending = client.status(controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test("client validates socket and timeout configuration", () => {
  assert.throws(() => new SearchIndexClient("relative.sock"), /absolute/);
  assert.throws(() => new SearchIndexClient("/tmp/search.sock", { timeoutMs: 0 }), /positive integer/);
});
