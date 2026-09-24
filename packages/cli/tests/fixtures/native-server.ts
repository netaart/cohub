import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { NativeRuntimeEvent } from "@neta-art/cohub";
import type { IngestTransport } from "../../src/runtime/native/ingest.js";

type Ingested = Extract<NativeRuntimeEvent, { type: "ingest" }>["input"];

/**
 * The server's side of ingest, in memory: Turns keyed by id, idempotent, parents required.
 * `stop` marks Turns a status request reports as stop-requested.
 */
export function fakeNativeServer() {
  const turns = new Map<string, { sessionId: string; settled: boolean; parentTurnId: string | null; origin?: string }>();
  const batches: Ingested[] = [];
  const progress: Array<{ turnId: string; from: number; messages: number }> = [];
  const statusRequests: string[] = [];
  const controllable = new Map<string, boolean | undefined>();
  let knownCalls = 0;
  const stop = new Set<string>();
  const transport: IngestTransport = {
    async known(turnIds) {
      knownCalls += 1;
      assert(turnIds.length <= 500, "known is chunked to the protocol limit");
      return turnIds.flatMap((turnId) => { const turn = turns.get(turnId); return turn ? [{ turnId, sessionId: turn.sessionId, settled: turn.settled }] : []; });
    },
    async ingest(event) {
      assert(event.input.turns.length <= 50, "ingest is batched small enough to answer in time");
      batches.push(event.input);
      return { turns: event.input.turns.map((turn) => {
        const parent = turn.parentTurnId ? turns.get(turn.parentTurnId) : null;
        if (turn.parentTurnId && !parent) throw new Error("Parent Turn is not recorded");
        const existing = turns.get(turn.turnId);
        const sessionId = existing?.sessionId ?? parent?.sessionId ?? randomUUID();
        turns.set(turn.turnId, { sessionId, settled: turn.result !== null || Boolean(existing?.settled), parentTurnId: turn.parentTurnId, origin: turn.origin });
        return { turnId: turn.turnId, sessionId, forked: false, settled: turn.result !== null, created: !existing, changed: true };
      }) };
    },
    async progress(event) { progress.push({ turnId: event.turnId, from: event.progress.from ?? 0, messages: event.progress.messages.length }); return { accepted: true }; },
    async status(_sessionId, turnId, value) {
      statusRequests.push(turnId);
      controllable.set(turnId, value);
      return { abortRequested: stop.has(turnId), status: turns.get(turnId)?.settled ? "completed" : "running" };
    },
  };
  /** The same server behind the Runtime's WebSocket event shape. */
  const send = async (event: NativeRuntimeEvent): Promise<unknown> => {
    if (event.type === "ingest") return await transport.ingest(event);
    if (event.type === "known") return { turns: await transport.known(event.input.turnIds) };
    if (event.type === "progress") return await transport.progress(event);
    return await transport.status(event.sessionId, event.turnId, event.controllable);
  };
  return { turns, batches, progress, stop, statusRequests, controllable, transport, send, get knownCalls() { return knownCalls; } };
}
