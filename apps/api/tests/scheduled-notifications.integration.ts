import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import type { SessionTurnRecord } from "@cohub/protocol/model";

const SPACE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CRON = "33333333-3333-4333-8333-333333333333";
const USER = "schedule-owner";
const realtime: Array<{ type: string; payload: unknown }> = [];
const finalized: Array<{ type: string; payload: unknown }> = [];
const states: unknown[] = [];
const cleared: unknown[] = [];
const snapshots: unknown[] = [];
const updates: Array<Record<string, unknown>> = [];
let appPrincipal = true;
let canManage = true;
let actor = USER;

function scheduledJob() {
  return {
    id: CRON,
    userUuid: USER,
    spaceId: SPACE,
    sessionId: SESSION,
    taskType: "send_message",
    title: "Remember the conversation",
    cronExpression: "0 9 * * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    bullJobKey: `cron-${CRON}`,
    payload: {
      content: [{ type: "text", text: "Update memory" }],
      sessionId: SESSION,
      auth: { type: "delegated_prompt", appId: "schedule-manager", appViewerGrantId: "grant-1" },
      origin: { kind: "scheduled_prompt", turnId: "creator-turn" },
      requestSource: { turnId: "creator-turn", via: "app" },
    } as Record<string, unknown>,
  };
}
let job = scheduledJob();

const mocks: Array<{ restore(): void }> = [];
function replace(specifier: string, namedExports: Record<string, unknown>) {
  mocks.push(mock.module(specifier, { namedExports }));
}
const unexpected = () => { throw new Error("Unexpected dependency call"); };

replace("@cohub/core/sessions", {
  createSessionSnapshotScheduler: () => async (...args: unknown[]) => { snapshots.push(args); },
  publishSessionSnapshot: unexpected,
});
replace("@cohub/core/labels", { listResourceLabelRefs: async () => ["Memory"] });
replace("../src/channels.js", {
  dispatchRealtimeEvent: async (event: { type: string; payload: unknown }) => { realtime.push(event); },
  dispatchOutboundMessage: unexpected,
  getProviderMessageRefBySessionMessage: unexpected,
  getBindingsBySessionId: unexpected,
});
replace("../src/space-events.js", {
  dispatchSpaceDomainEvent: async (event: { type: string; payload: unknown }) => { finalized.push(event); },
});
replace("../src/session-stream-snapshot.js", {
  clearSessionStreamSnapshot: async (input: unknown) => { cleared.push(input); },
});
replace("../src/realtime-events.js", {
  toRealtimeMessageRecord: unexpected,
  toRealtimeTurnRecord: (turn: SessionTurnRecord) => turn,
  dispatchSessionTurnState: async (...args: unknown[]) => { states.push(args); },
});
replace("../src/db/index.js", {
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [job] }) }) }) },
});
replace("../src/lib/middleware.js", {
  useAuth: () => ({ uuid: actor }),
  getOptionalAuth: () => ({ uuid: actor }),
  requireValidId: (id: string) => id === CRON,
  getAppSessionPrincipal: () => appPrincipal ? { userUuid: actor } : null,
  authzDenied: (c: { json: (body: unknown, status: number) => Response }) => c.json({ message: "forbidden" }, 403),
});
replace("../src/permissions.js", {
  hasPermission: async (_user: unknown, permission: string) => {
    assert.equal(permission, "cronjob.manage");
    return canManage;
  },
});
replace("../src/tasks.js", {
  updateCronJob: async (_current: unknown, patch: Record<string, unknown>) => {
    updates.push(structuredClone(patch));
    job = { ...job, ...patch };
    return job;
  },
  enableCronJob: unexpected,
  disableCronJob: unexpected,
  removeCronJob: unexpected,
});
replace("../src/user-profiles.js", {
  getProfilesByUuids: async () => new Map(),
  fallbackPublicUserProfile: (userUuid: string) => ({ userUuid, displayName: "Schedule owner" }),
});
replace("../src/task-run-privacy.js", { sanitizeTaskRunPricingForViewer: unexpected });

const { dispatchTurnFinalized } = await import("../src/session-output.js");
const { default: router } = await import("../src/routes/cron-jobs.route.js");
const { Hono } = await import("hono");
const app = new Hono().route("/api/cron-jobs", router);
after(() => { for (const item of mocks.reverse()) item.restore(); });

function reset() {
  realtime.length = finalized.length = states.length = cleared.length = snapshots.length = updates.length = 0;
  appPrincipal = true;
  canManage = true;
  actor = USER;
  job = scheduledJob();
}

function turn(status: SessionTurnRecord["status"], notifyOnSuccess?: boolean): SessionTurnRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444", sessionId: SESSION, userUuid: USER,
    sequence: 1, status, intent: "followup", userContent: [], userText: "Update memory",
    assistantContent: [], assistantText: "Memory updated", provider: "cohub", model: "test",
    stopReason: null, errorMessage: null, finalUsage: null, totalUsage: null,
    summary: null, intermediateIndex: null, intermediateSummary: null,
    meta: { context: { kind: "scheduled_task", taskRunId: "run-1", cronJobId: CRON,
      ...(notifyOnSuccess === undefined ? {} : { notifyOnSuccess }) } },
    startedAt: null, completedAt: "2026-10-22T01:00:00Z", durationMs: 100,
    createdAt: "2026-10-22T01:00:00Z", updatedAt: "2026-10-22T01:00:00Z",
  };
}
const finish = (value: SessionTurnRecord) => dispatchTurnFinalized({ spaceId: SPACE, sessionId: SESSION, turn: value });
const patch = (body: unknown) => app.request(`/api/cron-jobs/${CRON}`, {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("silent successful schedules still finalize and update state without notifying", async () => {
  reset();
  const value = turn("completed", false);
  await finish(value);
  assert.deepEqual(finalized.map((event) => event.type), ["session.turn.finalized"]);
  assert.deepEqual(finalized[0]?.payload, { turn: value, sessionLabelRefs: ["Memory"] });
  assert.deepEqual(states, [[SPACE, value]]);
  assert.deepEqual(cleared, [{ spaceId: SPACE, sessionId: SESSION, turnId: value.id }]);
  assert.deepEqual(snapshots, [[SESSION, 1]]);
  assert.deepEqual(realtime, [], "only the completion notification is suppressed");
});

test("defaults and unsuccessful schedules retain their existing notifications", async () => {
  const cases = [turn("completed"), turn("completed", true), ...["failed", "interrupted", "cancelled"].map((status) => turn(status as SessionTurnRecord["status"], false))];
  const ordinary = turn("completed", false);
  ordinary.meta = { context: { kind: "public_api", notifyOnSuccess: false } };
  cases.push(ordinary);
  for (const value of cases) {
    reset();
    await finish(value);
    assert.deepEqual(realtime.map((event) => event.type), ["session.turn.notify"], JSON.stringify(value.meta));
    const notification = realtime[0];
    assert.ok(notification);
    assert.equal((notification.payload as { status: string }).status, value.status);
    assert.equal(finalized.length, 1);
    assert.equal(states.length, 1);
  }
});

test("an authorized App changes only its own schedule's success notification setting", async () => {
  for (const notifyOnSuccess of [false, true]) {
    reset();
    const original = structuredClone(job.payload);
    const response = await patch({ notifyOnSuccess });
    assert.equal(response.status, 200);
    assert.deepEqual(updates, [{ payload: { ...original, notifyOnSuccess } }]);
    const result = await response.json() as { job: { payload: Record<string, unknown> } };
    assert.deepEqual(result.job.payload, { ...original, notifyOnSuccess });
  }
});

test("notification updates do not grant Apps payload or other users' schedule access", async () => {
  reset();
  assert.equal((await patch({ notifyOnSuccess: false, payload: { content: [] } })).status, 403);
  assert.deepEqual(updates, []);
  reset();
  actor = "another-user";
  assert.equal((await patch({ notifyOnSuccess: false })).status, 403);
  assert.deepEqual(updates, []);
  reset();
  canManage = false;
  assert.equal((await patch({ notifyOnSuccess: false })).status, 403);
  assert.deepEqual(updates, []);
});

test("editing content preserves an omitted notification setting and accepts an explicit boolean", async () => {
  for (const notifyOnSuccess of [undefined, true, false]) {
    reset();
    appPrincipal = false;
    job.payload.notifyOnSuccess = false;
    const { auth, origin, requestSource } = job.payload;
    const content = [{ type: "text", text: "Remember the updated conversation" }];
    const payload = { content, ...(notifyOnSuccess === undefined ? {} : { notifyOnSuccess }) };
    const response = await patch({ payload });
    assert.equal(response.status, 200);
    const expected = { content, auth, origin, requestSource, notifyOnSuccess: notifyOnSuccess ?? false };
    assert.deepEqual(updates, [{ payload: expected }]);
    const result = await response.json() as { job: { payload: Record<string, unknown> } };
    assert.deepEqual(result.job.payload, expected);
  }
});

test("invalid notification settings and unsupported task types never update the schedule", async () => {
  for (const value of ["false", null, 0, {}, []]) {
    reset();
    assert.equal((await patch({ title: "Renamed schedule", notifyOnSuccess: value })).status, 400);
    assert.deepEqual(updates, []);
  }
  reset();
  job.taskType = "save_checkpoint";
  assert.equal((await patch({ notifyOnSuccess: false })).status, 400);
  assert.deepEqual(updates, []);
});

test("account payload replacements reject non-boolean notification settings before saving", async () => {
  for (const notifyOnSuccess of ["false", null, 0, {}, []]) {
    reset();
    appPrincipal = false;
    const payload = { content: [{ type: "text", text: "Update memory" }], notifyOnSuccess };
    assert.equal((await patch({ payload })).status, 400);
    assert.deepEqual(updates, []);
  }
});
