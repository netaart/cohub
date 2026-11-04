import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { COHUB_PI_PROTOCOL } from "../src/runtime/native/pi-extension.js";
import { PI_DISCONNECTED, PiLink } from "../src/runtime/native/pi-link.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  setNoDelay() {}
  write() { return true; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("close"); }
}

test("an oversized line is dropped without dropping the connection", () => {
  const dropped: Array<[string | null, number]> = [];
  const link = new PiLink({ socketPath: "/unused", owns: () => true, onDroppedLine: (sessionId, bytes) => dropped.push([sessionId, bytes]) });
  const socket = new FakeSocket();
  (link as unknown as { accept(socket: FakeSocket): void }).accept(socket);
  const events: unknown[] = [];
  link.subscribe("pi-session", (event) => events.push(event.type));
  const line = (message: unknown) => Buffer.from(`${JSON.stringify(message)}\n`);
  socket.emit("data", line({ type: "hello", protocol: COHUB_PI_PROTOCOL, pid: 1, cwd: "/", sessionId: "pi-session", idle: true }));
  const huge = line({ type: "event", sessionId: "pi-session", event: { type: "turn_end", context: "x".repeat(9 * 1024 * 1024) } });
  // Split across chunks the way a socket delivers it, with the next event in the last chunk.
  for (let offset = 0; offset < huge.length; offset += 64 * 1024) {
    const end = Math.min(offset + 64 * 1024, huge.length);
    socket.emit("data", end === huge.length ? Buffer.concat([huge.subarray(offset, end), line({ type: "event", event: { type: "agent_end", willRetry: false } })]) : huge.subarray(offset, end));
  }
  // The limit counts UTF-8 bytes, also for a line that arrives in one chunk.
  const wide = line({ type: "event", event: { type: "turn_end", context: "😀".repeat(2_200_000) } });
  socket.emit("data", Buffer.concat([wide, line({ type: "event", event: { type: "agent_settled" } })]));
  assert.equal(socket.destroyed, false);
  assert.deepEqual(events, ["agent_end", "agent_settled"]);
  assert.deepEqual(dropped, [["pi-session", huge.length - 1], ["pi-session", wide.length - 1]]);
  assert.notEqual(link.find("pi-session"), null);
  assert(!events.includes(PI_DISCONNECTED));
});
