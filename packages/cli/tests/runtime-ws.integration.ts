import assert from "node:assert/strict";
import { testNativeRuntime } from "./fixtures/runtime-native.js";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { serveRuntime } from "../src/runtime/connection.js";

test("Runtime starts and reports more than 64 pending Sessions in bounded recovery frames", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-recovery-batches-"));
  const spaceId = crypto.randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["pi"] });
  const stateDirectory = join(runtime.stateRoot, "executions");
  await mkdir(stateDirectory, { recursive: true });
  const expected = Array.from({ length: 65 }, () => ({ sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), harness: "pi" as const }));
  await Promise.all(expected.map((execution) => writeFile(join(stateDirectory, `${execution.sessionId}.json`), JSON.stringify({
    version: 2, requestId: null, sessionId: execution.sessionId, turnId: execution.turnId,
    session: { harness: execution.harness, nativeSessionId: crypto.randomUUID(), path: join(root, "missing.jsonl"), cwd: root },
  }))));

  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const controller = new AbortController();
  const frames: Array<typeof expected> = [];
  const received = new Promise<void>((resolve, reject) => {
    server.on("connection", (socket) => socket.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "runtime.hello") {
          socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
          return;
        }
        if (frame.type !== "runtime.recovery") return;
        frames.push(frame.executions);
        if (frames.flat().length === expected.length) resolve();
      } catch (error) { reject(error); }
    }));
  });
  const running = serveRuntime({ spaceId, cwd: root, url: `ws://127.0.0.1:${address.port}`, capabilities: { harnesses: ["pi"], models: [] }, token: async () => "fixture-token", signal: controller.signal, executor: runtime.native.executor, onReady: () => {} });
  try {
    await received;
    assert.deepEqual(frames.map((frame) => frame.length), [64, 1]);
    const bySession = (value: typeof expected) => [...value].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    assert.deepEqual(bySession(frames.flat()), bySession(expected));
  } finally {
    controller.abort(); await running; await runtime.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime finishes local work after its transport disconnects and replays the durable result", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-detached-"));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const controller = new AbortController();
  const spaceId = crypto.randomUUID(), sessionId = crypto.randomUUID(), turnId = crypto.randomUUID(), recoverRequestId = crypto.randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["pi"] });
  let connections = 0;
  let rejectFailure: (error: unknown) => void = () => {};
  const completed = new Promise<void>((resolve, reject) => {
    rejectFailure = reject;
    server.on("connection", (socket) => {
      const connection = ++connections;
      const send = (value: unknown) => socket.send(JSON.stringify(value));
      socket.on("message", (raw) => {
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.type === "runtime.hello") {
            send({ type: "runtime.ready", connectionId: crypto.randomUUID() });
            if (connection === 1) send({ type: "turn.start", requestId: turnId, input: {
              spaceId, sessionId, turnId, userMessageId: turnId, harness: "pi", accessMode: "full_access",
              messages: [{ turnId, userMessageId: turnId, userId: "author", content: [{ type: "text", text: "slow transport test" }] }],
              context: { complete: true, revision: "initial", throughTurnId: null, messages: [] },
            } });
            return;
          }
          if (connection === 1 && frame.type === "runtime.event" && frame.event?.type === "text.delta") {
            socket.terminate();
            return;
          }
          if (connection > 1 && frame.type === "runtime.recovery") {
            assert.deepEqual(frame.executions, [{ sessionId, turnId, harness: "pi" }]);
            send({ type: "turn.recover", requestId: recoverRequestId, execution: { spaceId, sessionId, turnId, harness: "pi" } });
            return;
          }
          if (connection > 1 && frame.type === "runtime.event" && frame.requestId === recoverRequestId) {
            if (frame.event.type === "turn.error") throw new Error(frame.event.message);
            if (frame.event.type === "turn.end") {
              assert.equal(frame.event.message.stopReason, "stop", "transport loss must not abort local execution");
              assert(frame.event.message.content.some((block: { type: string; text?: string }) => block.type === "text" && block.text?.includes("new session")));
              send({ type: "turn.ack", requestId: frame.requestId, revision: "completed", turnId });
            }
            if (frame.event.type === "turn.acknowledged") resolve();
          }
        } catch (error) { reject(error); controller.abort(); }
      });
    });
  });
  const running = serveRuntime({ spaceId, cwd: root, url: `ws://127.0.0.1:${address.port}`, capabilities: { harnesses: ["pi"], models: [] }, token: async () => "fixture-token", signal: controller.signal, executor: runtime.native.executor, onReady: () => {} });
  void running.catch(rejectFailure);
  try {
    await completed;
    assert(connections >= 2);
  } finally {
    controller.abort(); await running; await runtime.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

for (const harness of ["pi", "codex"] as const) for (const resolved of [false, true]) {
  test(`${harness} WebSocket execution ${resolved ? "retires a confirmed execution" : "acknowledges native resume"}`,  { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "cohub-runtime-ws-"));
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const controller = new AbortController();
    const spaceId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const previousId = crypto.randomUUID();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const turns = [crypto.randomUUID(), crypto.randomUUID()];
    const runtime = await testNativeRuntime({ spaceId, root, harnesses: [harness] });
    runtime.source.addTurn(sessionId, previousId, { userContent: [{ type: "text", text: "historical fact" }] });
    let round = 0;
    let contextRequests = 0;
    let deltas = 0;
    const resumes: string[] = [];
    let rejectFailure: (error: unknown) => void = () => {};
    const completed = new Promise<void>((resolve, reject) => {
      rejectFailure = reject;
      server.on("connection", (socket) => {
        const send = (value: unknown) => socket.send(JSON.stringify(value));
        const start = () => send({ type: "turn.start", requestId: ids[round], input: {
          spaceId, sessionId, turnId: turns[round], userMessageId: turns[round], harness,
          messages: [{ turnId: turns[round], userMessageId: turns[round], userId: "author", content: [{ type: "text", text: "continue" }] }], accessMode: "full_access",
          context: { complete: false, revision: round === 0 ? "one" : "two", throughTurnId: round === 0 ? previousId : turns[0], messages: [] },
        } });
        socket.on("message", (raw) => {
          try {
            const value = JSON.parse(raw.toString());
            if (value.type === "runtime.hello") { send({ type: "runtime.ready", connectionId: crypto.randomUUID() }); start(); return; }
            if (value.type !== "runtime.event") return;
            const event = value.event;
            if (event.type === "context.required") {
              contextRequests++;
              if (resolved && round === 1) assert.deepEqual(event.pendingTurnIds, [turns[0]], "only the actual pending projection is queried");
              send({ type: "session.context", requestId: value.requestId, context: { complete: true, revision: round === 0 ? "one" : "two", throughTurnId: round === 0 ? previousId : turns[0], ...(resolved && round === 1 ? { resolvedTurnIds: [turns[0]] } : {}), messages: [] } });
            }
            if (event.type === "text.delta") deltas++;
            if (event.type === "turn.error") throw new Error(event.message);
            if (event.type === "turn.end") {
              assert(deltas > 0, "deltas must arrive before completion");
              if (round === 0) {
                // Pi receives durable history through its native session file; Codex handoff has no native history channel yet.
                const expected = harness === "pi" ? "history retained" : "native resumed";
                assert(event.message.content.some((block: { type: string; text?: string }) => block.type === "text" && block.text?.includes(expected)));
              }
              resumes.push(event.resume);
              if (resolved && round === 0) {
                runtime.source.addTurn(sessionId, turns[0], { assistantContent: [{ type: "text", text: "completed" }] });
                round++;
                start();
                return;
              }
              send({ type: "turn.ack", requestId: value.requestId, revision: round === 0 ? "two" : "three", turnId: turns[round] });
            }
            if (event.type === "turn.acknowledged") {
              if (round++ === 0) start();
              else resolve();
            }
          } catch (error) { reject(error); controller.abort(); }
        });
      });
    });
    const running = serveRuntime({ spaceId, cwd: root, url: `ws://127.0.0.1:${address.port}`, capabilities: { harnesses: [harness], models: [] }, token: async () => "fixture-token", signal: controller.signal, executor: runtime.native.executor, onReady: () => {} });
    void running.catch(rejectFailure);
    try {
      await completed;
      assert.equal(contextRequests, resolved ? 1 : 0);
      assert.deepEqual(resumes, ["handoff", resolved ? "handoff" : "native"]);
    } finally {
      controller.abort();
      await running;
      await runtime.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
