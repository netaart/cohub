import assert from "node:assert/strict";
import { testNativeRuntime } from "./fixtures/runtime-native.js";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket, { WebSocketServer } from "ws";
import type { RuntimeRegistration, RuntimeTurnInput } from "@cohub/protocol";
import { createRuntimeRelay } from "../../../apps/gateway/src/relay/runtime-relay.js";
import { exchangeRuntimeTurn } from "../../../apps/agent/src/runtime/exchange.js";
import { createRuntimeStream } from "../../../apps/agent/src/stream/runtime-stream.js";
import { buildPatchOpsForContentDelta } from "../../../apps/agent/src/stream/patch-delta.js";
import { SessionGenerationStreamClient } from "../../sdk/src/session-generation-stream.js";
import { SessionPatchReducer } from "../../sdk/src/session-patch-reducer.js";
import type { ContentBlock } from "@cohub/protocol/core";
import { WebsocketClient } from "../../sdk/src/websocket.js";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import { serveRuntime } from "../src/runtime/connection.js";

for (const deliveredBeforeFailure of [false, true]) test(`failed publication resynchronizes SDK with a keyframe (${deliveredBeforeFailure})`, async () => {
  const identity = { spaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), userMessageId: crypto.randomUUID() };
  const reducer = new SessionPatchReducer();
  let calls = 0;
  const stream = createRuntimeStream(identity, async (event) => {
    calls++;
    const ops = buildPatchOpsForContentDelta(event);
    if (calls !== 1 || deliveredBeforeFailure) assert(reducer.applyPatch({ ...identity, seq: event.seq, baseSeq: event.baseSeq, ops }).applied);
    if (calls === 1) throw new Error("delivery outcome unknown");
  });
  stream.apply({ type: "message.start", ordinal: 0 });
  stream.apply({ type: "content.replace", ordinal: 0, content: [{ type: "text", text: "old" }, { type: "thinking", thinking: "removed" }] });
  await stream.flush();
  stream.apply({ type: "content.replace", ordinal: 0, content: [{ type: "text", text: "final" }] });
  await stream.flush();
  const state = reducer.get(identity);
  assert.equal(state.patchSeq, 2);
  assert.deepEqual(state.contentBlocks, [{ type: "text", text: "final", _meta: { streamIndex: 0 } }]);
  stream.dispose();
});

test("multiple removed blocks keep stable stream identities through the SDK reducer", () => {
  const identity = { spaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() };
  const reducer = new SessionPatchReducer();
  let sequence = 0;
  const apply = (content: ContentBlock[]) => {
    const baseSeq = sequence++;
    const ops = buildPatchOpsForContentDelta({ ...identity, type: "stream_update", sourceMessageId: "user", timestamp: Date.now(), seq: sequence, baseSeq, content, snapshotContent: content, replaceContent: true });
    const result = reducer.applyPatch({ ...identity, seq: sequence, baseSeq, ops });
    assert(result.applied);
    assert.deepEqual(result.state.contentBlocks, content);
    return ops;
  };
  const blocks: ContentBlock[] = [0, 1, 2, 3].map((index) => ({ type: "text", text: `block ${index}`, _meta: { streamIndex: index } }));
  apply(blocks);
  assert.deepEqual(apply(blocks.filter((_, index) => index === 0 || index === 3)).filter((op) => op.o === "remove").map((op) => op.p), ["/message/content/blocks/2", "/message/content/blocks/1"]);
  assert.deepEqual(apply([]).filter((op) => op.o === "remove").map((op) => op.p), ["/message/content/blocks/3", "/message/content/blocks/0"]);
  apply([{ type: "text", text: "fresh", _meta: { streamIndex: 0 } }]);
});

for (const harness of ["pi", "codex"] as const) for (const disconnect of ["all", "peer", "ack-error"] as const) {
  test(`${harness}: actual Gateway -> Runtime -> SDK, lost ack (${disconnect} disconnect)`,  { timeout: 25_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "cohub-relay-integration-"));
    const registrations = new Map<string, RuntimeRegistration>();
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const peers = new Set<WebSocket>();
    const spaceId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    let port = 0;
    let drop = disconnect !== "ack-error";
    let readyCount = 0;
    let readyResolve: () => void = () => {};
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    const relay = createRuntimeRelay({
      secret: "test-secret", endpoint: (space, connection) => `ws://127.0.0.1:${port}/peer/${space}?connection=${connection}`,
      authorize: async (token) => token === "test-token" ? { ok: true, userId: "owner" } : { ok: false, status: 401 },
      claim: async (space, record) => { if (registrations.has(space)) return false; registrations.set(space, record); return true; },
      renew: async (space, record) => registrations.get(space) === record,
      release: async (space, record) => { if (registrations.get(space) === record) registrations.delete(space); },
    });
    server.on("upgrade", (request, socket, head) => wss.handleUpgrade(request, socket, head, (ws) => {
      if (request.url?.startsWith("/peer/")) {
        peers.add(ws); ws.once("close", () => peers.delete(ws));
        relay.peer(ws, request, spaceId);
      }
      else {
        const originalSend = ws.send.bind(ws);
        ws.send = ((data: string, ...args: unknown[]) => {
          const frame = JSON.parse(String(data));
          if (frame.type === "turn.ack" && drop) {
            drop = false;
            for (const connected of disconnect === "all" ? wss.clients : peers) connected.terminate();
            return;
          }
          Reflect.apply(originalSend, ws, [data, ...args]);
        }) as typeof ws.send;
        relay.control(ws);
      }
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert(address && typeof address !== "string"); port = address.port;
    const controller = new AbortController();
    const runtime = await testNativeRuntime({ spaceId, root, harnesses: [harness] });
    const { results } = runtime.native.executor;
    const acknowledge = results.acknowledge.bind(results);
    let failAcknowledgement = disconnect === "ack-error";
    results.acknowledge = async (...args) => {
      if (failAcknowledgement) { failAcknowledgement = false; throw new Error("Simulated local write failure"); }
      return acknowledge(...args);
    };
    const running = serveRuntime({ spaceId, cwd: root, url: `ws://127.0.0.1:${port}/runtime`, capabilities: { harnesses: [harness], models: [] }, token: async () => "test-token", signal: controller.signal, executor: runtime.native.executor, onReady: () => { readyCount++; readyResolve(); } });
    const turnId = crypto.randomUUID();
    const input: RuntimeTurnInput = { spaceId, sessionId, turnId, userMessageId: turnId, harness, accessMode: "full_access", messages: [
      { turnId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), userId: "earlier-author", content: [{ type: "text", text: "first batch input" }] },
      { turnId, userMessageId: turnId, userId: "owner-author", content: [{ type: "text", text: "continue" }] },
    ], context: { complete: true, revision: "initial", throughTurnId: null, messages: [] } };
    const realtime = new WebsocketClient({ url: "ws://unused", getAccessToken: () => "fixture" });
    realtime.state = "open";
    const sdk = new SessionGenerationStreamClient(realtime, spaceId, sessionId);
    const emitPresentation = (event: ChannelEnvelope) => (realtime as unknown as { emit(type: "event", event: ChannelEnvelope): void }).emit("event", event);
    const visibleTexts: string[] = [];
    const syncErrors: string[] = [];
    const unsubscribe = sdk.subscribe({ state: (event) => { visibleTexts.push(event.state.contentBlocks.map((block) => block.type === "text" ? block.text : "").join("")); }, outOfSync: (event) => { syncErrors.push(event.reason); } });
    let patches = 0;
    const stream = createRuntimeStream({ spaceId, sessionId, turnId, userMessageId: turnId }, async (event) => {
      patches++;
      emitPresentation({ id: crypto.randomUUID(), timestamp: Date.now(), domain: "session", type: "session.turn.patch", spaceId, sessionId,
        payload: { turnId, messageId: event.messageId ?? null, messageOrdinal: event.messageOrdinal, seq: event.seq, baseSeq: event.baseSeq, anchorUserMessageId: turnId, ops: buildPatchOpsForContentDelta(event) },
      });
    });
    let ends = 0;
    let acknowledgementErrors = 0;
    let requestId = "";
    try {
      await ready;
      await exchangeRuntimeTurn({ input, signal: new AbortController().signal, headers: { "x-worker-secret": "test-secret" }, reconnectMs: 8000, handshakeMs: 1000,
        onAcknowledgementError: () => { acknowledgementErrors++; },
        endpoint: async () => { const record = registrations.get(spaceId); if (!record) throw new Error("not connected"); return record.endpoint; },
        event: async (event, send, request) => {
          requestId = request;
          if (event.type === "message.start" || event.type === "text.delta" || event.type === "content.replace") stream.apply(event);
          if (event.type === "turn.end") { ends++; await stream.flush(); send({ type: "turn.ack", requestId: request, turnId, revision: "completed" }); }
        },
      });
      assert.equal(ends, disconnect === "ack-error" ? 1 : 2, "only a lost transport replays the end result");
      assert.equal(acknowledgementErrors, disconnect === "ack-error" ? 1 : 0);
      if (disconnect === "ack-error") assert.equal(readyCount, 1, "a local acknowledgement failure must not close the shared Runtime connection");
      assert(patches > 0, "native stream reaches the SDK path");
      assert(visibleTexts.some((value) => /new session|native resumed/.test(value)), "SDK receives actual streamed answer text");
      assert.deepEqual(syncErrors, [], "stream identities and sequence numbers stay consistent");
      // An acknowledged result leaves no receipt behind; one whose local acknowledgement failed is kept.
      if (disconnect === "ack-error") assert(await results.recover(input, requestId));
      else assert.equal(await results.recover(input, requestId), null);
      const next = await runtime.native.executor.sessions.prepare({ ...input, cwd: root, turnId: crypto.randomUUID(), context: { complete: false, revision: "completed", throughTurnId: turnId, messages: [] }, resumable: () => true });
      assert.equal(next.resume, "native");
      const native = await readFile(next.session.path, "utf8");
      assert(native.includes("first batch input")); assert(!native.includes("earlier-author")); assert(!native.includes("owner-author"));
      if (harness === "pi") assert.equal(native.split('"role":"user"').length - 1, 1, "no repeated model execution");
      else assert.equal(native.split('"type":"turn_started"').length - 1, 1, "no repeated Codex turn");
      const unauthorized = new WebSocket(registrations.get(spaceId)?.endpoint ?? "", { headers: { "x-worker-secret": "wrong" } });
      assert.equal(await new Promise<number>((resolve) => unauthorized.once("close", resolve)), 4401);
    } finally {
      controller.abort(); await running; await runtime.close(); stream.dispose(); unsubscribe();
      for (const connected of wss.clients) connected.terminate();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
      await rm(root, { recursive: true, force: true });
    }
  });
}
