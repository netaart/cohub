import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { readRuntimeRecovery } from "@cohub/core/sessions";
import type { AgentRuntimeRecoveryJobData } from "@cohub/infra/agent-queue";
import type { RuntimeRecoveryState } from "@cohub/protocol";
import type { ClaimedTurnBatch } from "../batch.js";
import { RuntimeResultUnavailableError } from "../runtime/exchange.js";

const spaceId = crypto.randomUUID();
const dialect = new PgDialect();
const rows = new Map<string, ReturnType<typeof makeTurn>>();
const locked = new Set<string>();
const drained: string[] = [];
const recoveredBatches: ClaimedTurnBatch[] = [];
const persistedBatches: ClaimedTurnBatch[] = [];

function makeTurn(outcome: "saved" | "unknown" | "offline" = "unknown") {
  return {
    id: crypto.randomUUID(), sessionId: crypto.randomUUID(), userUuid: "owner", sequence: 1,
    status: "running", intent: "followup", userContent: [{ type: "text", text: "original" }],
    userText: "original", updatedAt: new Date(), outcome,
    meta: { harness: "pi", runtimeRecovery: { state: "attention", ownerUserId: "owner" } as RuntimeRecoveryState },
  };
}

function params(where: SQL) { return dialect.sqlToQuery(where).params; }
function matchingTurns(where: SQL, requireSession = true) {
  const values = params(where);
  return [...rows.values()].filter((row) => values.includes(row.id) && (!requireSession || values.includes(row.sessionId)) && ["running", "abort_requested"].includes(row.status));
}

const db = {
  select() {
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: (where: SQL) => ({
        limit: async () => {
          const turns = matchingTurns(where);
          if (turns.length) return turns;
          const values = params(where);
          const session = [...rows.values()].find((row) => values.includes(row.sessionId) && values.includes(spaceId));
          return session ? [{ id: session.sessionId }] : [];
        },
        orderBy: () => Promise.resolve([...rows.values()].filter((row) => params(where).includes(row.id)).sort((a, b) => a.sequence - b.sequence)),
      }),
    };
    return query;
  },
  update() {
    return { set: (value: { meta: SQL }) => ({ where: (where: SQL) => ({ returning: async () => {
      const patch = params(value.meta).find((param): param is string => typeof param === "string" && param.startsWith("{"));
      assert(patch);
      const updated = matchingTurns(where, false);
      for (const row of updated) Object.assign(row.meta, JSON.parse(patch));
      return updated.map((row) => ({ id: row.id }));
    } }) }) };
  },
};

mock.module("../db.js", { exports: { db } });
mock.module("../env.js", { exports: { env: { AGENT_STALE_ACTIVE_TURN_MS: 60_000 } } });
mock.module("../session-lock.js", { exports: { acquireSessionLock: async (sessionId: string) => locked.has(sessionId) ? null : { signal: new AbortController().signal, release: async () => {} } } });
mock.module("../persistence.js", { exports: {
  persistBatchUserMessages: async ({ batch }: { batch: ClaimedTurnBatch }) => { persistedBatches.push(batch); },
  publishSessionTurnsUpdated: async () => {},
  persistAssistantMessage: async ({ turnId }: { turnId: string }) => { const turn = rows.get(turnId); assert(turn); turn.status = "interrupted"; },
} });
mock.module("../queue.js", { exports: { enqueueAgentTurnJob: async ({ sessionId }: { sessionId: string }) => { drained.push(sessionId); } } });
mock.module("../logger.js", { exports: { logger: { warn: () => {}, debug: () => {} } } });
mock.module("../runtime/remote-runtime.js", { exports: {
  markRuntimeRecovery: async (id: string, state: RuntimeRecoveryState) => { const row = rows.get(id); assert(row); row.meta.runtimeRecovery = { ...row.meta.runtimeRecovery, ...state }; },
  executeRemoteHarnessTurn: async (input: { recovery: boolean; batch: ClaimedTurnBatch }) => {
    recoveredBatches.push(input.batch);
    assert.equal(input.recovery, true, "recovery must never dispatch new work");
    const row = rows.get(input.batch.ownerTurn.id); assert(row);
    if (row.outcome === "offline") throw new Error("offline");
    if (row.outcome === "unknown") throw new RuntimeResultUnavailableError("no result");
    row.status = "completed";
  },
} });

const { recoverRuntime } = await import("../runtime/recovery.js");
const job = (turn: ReturnType<typeof makeTurn>, confirmation?: AgentRuntimeRecoveryJobData["confirmation"]): AgentRuntimeRecoveryJobData => ({
  spaceId, sessionId: turn.sessionId, expectedTurnId: turn.id, expectedHarness: "pi", expectedOwnerUserId: "owner", confirmation,
});

test("Session recovery restores a saved result and marks an unavailable result for attention", async () => {
  rows.clear(); drained.length = 0;
  const saved = makeTurn("saved"); rows.set(saved.id, saved);
  assert.deepEqual(await recoverRuntime(job(saved)), { recovered: 1, attention: 0 });
  assert.equal(saved.status, "completed");
  assert.deepEqual(drained, [saved.sessionId]);

  const unknown = makeTurn("unknown"); rows.set(unknown.id, unknown);
  assert.deepEqual(await recoverRuntime(job(unknown)), { recovered: 0, attention: 1 });
  assert.equal(readRuntimeRecovery(unknown.meta)?.state, "attention");
});

test("Session recovery asks BullMQ to retry transient transport failures", async () => {
  rows.clear();
  const offline = makeTurn("offline"); rows.set(offline.id, offline);
  await assert.rejects(() => recoverRuntime(job(offline)), /transport is unavailable/);
  assert.equal(offline.status, "running");
});

test("Session recovery reconstructs only the original merged follow-up batch", async () => {
  rows.clear(); recoveredBatches.length = 0;
  const owner = makeTurn("saved");
  const first = makeTurn(); first.sessionId = owner.sessionId; first.status = "merged"; first.sequence = 1;
  first.meta = { ...first.meta, harness: "cohub", mergedIntoTurnId: owner.id } as typeof first.meta;
  owner.sequence = 2;
  owner.meta = { ...owner.meta, executionBatch: { ownerTurnId: owner.id, turnIds: [first.id, owner.id] } } as typeof owner.meta;
  rows.set(first.id, first); rows.set(owner.id, owner);
  await recoverRuntime(job(owner));
  assert.deepEqual(recoveredBatches[0]?.executionBatch.turnIds, [first.id, owner.id]);
  assert.equal(first.status, "merged");
  assert.equal(owner.status, "completed");
});

test("Session confirmation terminalizes the owner without reading a late local result", async () => {
  rows.clear(); recoveredBatches.length = 0; persistedBatches.length = 0;
  const owner = makeTurn(); rows.set(owner.id, owner);
  await recoverRuntime(job(owner, { actorUserId: "manager", revision: "snapshot" }));
  assert.equal(owner.status, "interrupted");
  assert.equal(readRuntimeRecovery(owner.meta)?.resolvedBy, "manager");
  assert.equal(recoveredBatches.length, 0);
  assert.deepEqual(persistedBatches[0]?.executionBatch.turnIds, [owner.id]);
});

test("Session recovery waits for the existing Session lock", async () => {
  rows.clear(); locked.clear();
  const owner = makeTurn(); rows.set(owner.id, owner); locked.add(owner.sessionId);
  await assert.rejects(() => recoverRuntime(job(owner)), /Session lock/);
  assert.equal(owner.status, "running");
});
