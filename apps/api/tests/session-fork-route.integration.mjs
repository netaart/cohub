import assert from "node:assert/strict";
import { mock, test } from "node:test";

const session = { id: crypto.randomUUID(), spaceId: crypto.randomUUID() };
const sourceId = crypto.randomUUID();
let sourceTurn, anchorReads = 0;
const forkInputs = [], queued = [];
const unused = () => { throw new Error("Unexpected dependency call"); };
const exportsFor = (names) => Object.fromEntries(names.map((name) => [name, unused]));
mock.module("../src/db/index.js", { namedExports: { db: {} } });
mock.module("../src/permissions.js", { namedExports: { hasPermission: async () => true } });
mock.module("../src/lib/middleware.js", { namedExports: {
  getOptionalAuth: unused, useAuth: () => ({ uuid: "owner" }), requireValidId: () => true, authzDenied: unused,
} });
mock.module("../src/space-sessions.js", { namedExports: {
  ...exportsFor(["attachActiveTurns", "getSpaceById", "getSessionMessageById", "listSessionMessages", "enqueueSessionAbort", "updateSpaceSessionInfo"]),
  getSpaceSessionById: async () => session,
  hydrateSessionParticipantProfiles: async (sessions) => sessions,
  enqueueSessionFork: async (input) => { queued.push(input); },
} });
mock.module("../src/session-content.js", { namedExports: exportsFor(["markMessageAsFull", "summarizeMessageForHistory"]) });
mock.module("../src/session-turns.js", { namedExports: {
  ...exportsFor(["createSignedTurnUrls", "getSessionTurnSequenceById", "hydrateTurnAuthorProfiles", "listSessionTurnIndex", "listSessionTurns", "listSessionTurnWindow"]),
  getSessionTurnById: async () => sourceTurn,
  findLatestVisibleAgentEntryId: async () => { anchorReads++; return "legacy-entry"; },
} });
mock.module("../src/session-stream-snapshot.js", { namedExports: exportsFor(["clearSessionStreamSnapshot", "getSessionStreamSnapshot"]) });
mock.module("../src/session-forks.js", { namedExports: {
  createSessionFork: async (input) => {
    forkInputs.push(input);
    return { session: { ...session, id: input.childSessionId }, fork: { anchorTurnId: input.turnId } };
  },
  listSessionForksForSessions: async () => [],
} });
mock.module("../src/realtime-events.js", { namedExports: { dispatchLabelAssignmentsUpdated: async () => {} } });
mock.module("../src/session-turn-response.js", { namedExports: exportsFor(["buildSessionTurnResponse"]) });
mock.module("../src/runtime.js", { namedExports: exportsFor(["getSessionRuntimeTurn"]) });
mock.module("../src/session-files.js", { namedExports: exportsFor(["listSessionFiles"]) });
const { default: router } = await import("../src/routes/sessions.route.js");

function setup(status, harness = "codex") {
  forkInputs.length = 0; queued.length = 0; anchorReads = 0;
  sourceTurn = { id: crypto.randomUUID(), sourceTurnId: sourceId, sequence: 4, status, executionKind: "agent", meta: { harness } };
}
const request = () => router.request(`/${session.id}/turns/${sourceTurn.id}/fork`, { method: "POST", body: JSON.stringify({ title: "A different path" }), headers: { "Content-Type": "application/json" } });

test("Codex fork routes settled source identities without the legacy fork queue", async () => {
  for (const status of ["completed", "failed", "interrupted"]) {
    setup(status);
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(forkInputs.length, 1);
    assert.equal(forkInputs[0].turnId, sourceId, "nested inherited turns use their original source identity");
    assert.equal(forkInputs[0].parentSessionId, session.id);
    assert.equal(forkInputs[0].sequence, 4);
    assert.equal(forkInputs[0].title, "A different path");
    assert.equal((await response.json()).session.id, forkInputs[0].childSessionId);
    assert.deepEqual(queued, [], "Codex prepares the native branch on its first local continuation");
    assert.equal(anchorReads, 0, "Codex does not depend on a legacy agent entry");
  }
});

test("Codex rejects unexecuted and unsettled fork anchors before any mutation", async () => {
  for (const status of ["queued", "running", "abort_requested", "merged", "cancelled"]) {
    setup(status);
    const response = await request();
    assert.equal(response.status, 400, status);
    assert.deepEqual(forkInputs, []);
    assert.deepEqual(queued, []);
  }
});

test("Cloud forks keep their durable entry and existing queue", async () => {
  setup("completed", "cohub");
  assert.equal((await request()).status, 200);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].anchorEntryId, "legacy-entry");
  assert.equal(queued[0].anchorTurnId, sourceId);
  assert.equal(anchorReads, 1);
});
