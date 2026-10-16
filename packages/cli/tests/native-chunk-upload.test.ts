import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeChunkUploads } from "../src/runtime/native/chunk-upload.js";

test("an uncertain chunk transfer disconnects before a queued upload can reuse its partial server state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const failure of ["timeout", "ack", "send", "premature"] as const) {
    const sent: string[] = [];
    let disconnected = 0;
    const uploads = new NativeChunkUploads(frame => {
      sent.push(frame.requestId);
      if (failure === "send") throw new Error("Connection backpressure");
    }, () => { disconnected++; uploads.close(new Error("Uncertain transfer disconnected")); });
    const first = uploads.upload("first", Buffer.from("original first result"));
    const second = uploads.upload("second", Buffer.from("original second result"));
    const results = Promise.allSettled([first, second]);
    await Promise.resolve();
    if (failure === "ack") uploads.acknowledge("first", 1);
    if (failure === "premature") assert.match(uploads.complete("first")?.message ?? "", /before all chunk acknowledgements/);
    t.mock.timers.tick(30_000);
    // Settle both requests even when the disconnect assertion will fail.
    const closed = disconnected;
    if (!closed) uploads.close(new Error("Test cleanup after missing disconnect"));
    const outcomes = await results;
    assert.equal(closed, 1, failure);
    assert.deepEqual(sent, ["first"], failure);
    assert(outcomes.every(result => result.status === "rejected"), failure);
  }
});
