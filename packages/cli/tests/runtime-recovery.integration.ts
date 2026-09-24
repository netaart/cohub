import assert from "node:assert/strict";
import { testNativeRuntime, type TestNativeRuntime } from "./fixtures/runtime-native.js";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import type { RuntimeRegistration, RuntimeTurnInput } from "@cohub/protocol";
import { createRuntimeRelay } from "../../../apps/gateway/src/relay/runtime-relay.js";
import { exchangeRuntimeTurn, RuntimeExecutionUncertainError } from "../../../apps/agent/src/runtime/exchange.js";
import { serveRuntime } from "../src/runtime/connection.js";

for (const harness of ["pi", "codex"] as const) test(`${harness}: cold Runtime restart recovers after the original exchange expires, without a Harness executable`, { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-recover-"));
  const server = createServer(), sockets = new WebSocketServer({ noServer: true });
  const spaceId = crypto.randomUUID();
  let registration: RuntimeRegistration | null = null;
  let port = 0, wakeups = 0, dropResult = true;
  let onReady = () => {};
  const relay = createRuntimeRelay({ secret: "secret", endpoint: (_space, connection) => `ws://127.0.0.1:${port}/peer?connection=${connection}`, authorize: async () => ({ ok: true, userId: "owner" }),
    claim: async (_space, record) => { if (registration) return false; registration = record; return true; },
    renew: async (_space, record) => registration === record,
    release: async (_space, record) => { if (registration === record) registration = null; },
    recover: async () => { wakeups++; },
  });
  server.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (ws) => {
    if (request.url?.startsWith("/peer")) {
      const send = ws.send.bind(ws);
      ws.send = ((data: string, ...args: unknown[]) => {
        if (dropResult && JSON.parse(String(data)).event?.type === "turn.end") {
          for (const connected of sockets.clients) connected.terminate();
          return;
        }
        Reflect.apply(send, ws, [data, ...args]);
      }) as typeof ws.send;
      relay.peer(ws, request, spaceId);
    } else relay.control(ws);
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string"); port = address.port;
  let controller = new AbortController();
  let runtime: TestNativeRuntime = await testNativeRuntime({ spaceId, root, harnesses: [harness] });
  const start = () => serveRuntime({ spaceId, cwd: root, url: `ws://127.0.0.1:${port}/runtime`, capabilities: { harnesses: [harness], models: [] }, token: async () => "token", signal: controller.signal, executor: runtime.native.executor, onReady: () => onReady() });
  let ready = new Promise<void>((resolve) => { onReady = resolve; });
  let running = start();
  const turnId = crypto.randomUUID(), userMessageId = crypto.randomUUID();
  const turn: RuntimeTurnInput = { spaceId, sessionId: crypto.randomUUID(), turnId, userMessageId, harness, accessMode: "full_access",
    messages: [
      { turnId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), userId: "earlier-author", content: [{ type: "text", text: "original batch input" }] },
      { turnId, userMessageId, userId: "author", content: [{ type: "text", text: "continue" }] },
    ], context: { complete: true, revision: "initial", throughTurnId: null, messages: [] } };
  const endpoint = async () => { if (!registration) throw new Error("offline"); return registration.endpoint; };
  let commits = 0;
  try {
    await ready;
    await assert.rejects(() => exchangeRuntimeTurn({ input: turn, requestId: turn.turnId, signal: new AbortController().signal, endpoint, headers: { "x-worker-secret": "secret" }, reconnectMs: 10,
      event: async () => {},
    }), RuntimeExecutionUncertainError);
    controller.abort(); await running; await runtime.close();
    runtime = await testNativeRuntime({ spaceId, root, harnesses: [harness], executables: { [harness]: join(root, "missing-harness-binary") } });
    const receipt = await runtime.native.executor.results.recover(turn); assert(receipt);
    const native = await readFile(receipt.session.path, "utf8");
    assert(native.includes("original batch input")); assert(!native.includes("earlier-author"));
    controller = new AbortController(); dropResult = false;
    ready = new Promise<void>((resolve) => { onReady = resolve; });
    running = start();
    await ready;
    await exchangeRuntimeTurn({ input: turn, recovery: true, signal: new AbortController().signal, endpoint, headers: { "x-worker-secret": "secret" },
      event: async (event, send, requestId) => {
        assert(["message.commit", "turn.end"].includes(event.type), "recovery cannot execute, stream new work, or request context");
        if (event.type === "turn.end") { commits++; send({ type: "turn.ack", requestId, turnId: turn.turnId, revision: "completed" }); }
      },
    });
    assert.equal(commits, 1); assert(wakeups >= 2);
    assert.equal(await readFile(receipt.session.path, "utf8"), native, "no model/tool replay");
    const next = await runtime.native.executor.sessions.prepare({ ...turn, cwd: root, turnId: crypto.randomUUID(), context: { complete: false, throughTurnId: turn.turnId, revision: "completed", messages: [] }, resumable: () => true });
    assert.equal(next.resume, "native");
    const unknown = { ...turn, sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() };
    await assert.rejects(() => exchangeRuntimeTurn({ input: unknown, recovery: true, signal: new AbortController().signal, endpoint, headers: { "x-worker-secret": "secret" }, event: async () => { assert.fail("unknown execution must not fabricate a result"); } }), RuntimeExecutionUncertainError);
    assert.equal(await runtime.native.executor.results.recover(unknown), null);
  } finally {
    controller.abort(); await running; await runtime.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
