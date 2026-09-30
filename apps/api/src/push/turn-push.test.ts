import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import type { ApnsClient, ApnsNotification, ApnsTarget } from "./apns.js";
import { buildTurnPushNotification, sendTurnPush, type TurnPushDependencies } from "./turn-push.js";

const NOW_MS = 1_790_000_000_000;

const baseInput = {
  userUuid: "user-1",
  spaceId: "space-1",
  sessionId: "session-1",
  turnId: "turn-1",
  status: "completed" as const,
  sessionTitle: "Refactor the parser",
  userPreview: "please refactor",
  nowMs: NOW_MS,
};

const turn = (overrides: Partial<SessionTurnRecord> = {}) =>
  ({ id: "turn-1", userUuid: "user-1", status: "completed", userText: "hi", ...overrides }) as SessionTurnRecord;

const createDeps = (overrides: Partial<TurnPushDependencies> = {}) => {
  const sent: Array<{ targets: readonly ApnsTarget[]; notification: ApnsNotification }> = [];
  const client: ApnsClient = {
    topics: ["com.example.app"],
    send: async (targets, notification) => {
      sent.push({ targets, notification });
    },
    close: () => {},
  };
  const calls = { listTargets: 0, getSessionTitle: 0 };
  const deps: TurnPushDependencies = {
    getClient: () => client,
    listTargets: async () => {
      calls.listTargets += 1;
      return [{ token: "a".repeat(64), environment: "sandbox", topic: "com.example.app" }];
    },
    getSessionTitle: async () => {
      calls.getSessionTitle += 1;
      return "Session title";
    },
    now: () => NOW_MS,
    ...overrides,
  };
  return { deps, sent, calls };
};

describe("buildTurnPushNotification", () => {
  it("builds the completed payload", () => {
    assert.deepEqual(buildTurnPushNotification(baseInput), {
      payload: {
        aps: {
          alert: { title: "Refactor the parser", "loc-key": "COHUB_TURN_COMPLETED" },
          sound: "default",
          "thread-id": "session-1",
        },
        cohub: { user: "user-1", space: "space-1", session: "session-1", turn: "turn-1", status: "completed" },
      },
      collapseId: "turn-1",
      expiresAt: NOW_MS / 1000 + 24 * 60 * 60,
    });
  });

  it("uses the failed loc-key and status", () => {
    const { payload } = buildTurnPushNotification({ ...baseInput, status: "failed" });
    assert.equal((payload.aps as { alert: Record<string, string> }).alert["loc-key"], "COHUB_TURN_FAILED");
    assert.equal((payload.cohub as Record<string, string>).status, "failed");
  });

  it("falls back to the user preview, then Cohub", () => {
    const title = (input: { sessionTitle?: string | null; userPreview?: string | null }) =>
      (buildTurnPushNotification({ ...baseInput, ...input }).payload.aps as { alert: { title: string } }).alert.title;
    assert.equal(title({ sessionTitle: null }), "please refactor");
    assert.equal(title({ sessionTitle: "   " }), "please refactor");
    assert.equal(title({ sessionTitle: null, userPreview: null }), "Cohub");
    assert.equal(title({ sessionTitle: "", userPreview: " " }), "Cohub");
  });
});

describe("sendTurnPush", () => {
  const input = (overrides: Partial<SessionTurnRecord> = {}) => ({
    spaceId: "space-1",
    sessionId: "session-1",
    turn: turn(overrides),
    userPreview: "hi",
  });

  it("sends completed and failed turns to the starter's targets with the session title", async () => {
    for (const status of ["completed", "failed"] as const) {
      const { deps, sent } = createDeps();
      await sendTurnPush(input({ status }), deps);
      assert.equal(sent.length, 1);
      const payload = sent[0]?.notification.payload as { aps: { alert: { title: string } }; cohub: { status: string } };
      assert.equal(payload.aps.alert.title, "Session title");
      assert.equal(payload.cohub.status, status);
    }
  });

  it("ignores other statuses without touching the database", async () => {
    for (const status of ["interrupted", "cancelled", "merged", "running"] as const) {
      const { deps, sent, calls } = createDeps();
      await sendTurnPush(input({ status }), deps);
      assert.equal(sent.length, 0);
      assert.equal(calls.listTargets, 0);
    }
  });

  it("does nothing when APNs is not configured", async () => {
    const { deps, calls } = createDeps({ getClient: () => null });
    await sendTurnPush(input(), deps);
    assert.equal(calls.listTargets, 0);
  });

  it("skips turns without a starter", async () => {
    const { deps, calls } = createDeps();
    await sendTurnPush(input({ userUuid: null }), deps);
    assert.equal(calls.listTargets, 0);
  });

  it("skips the title lookup when the user has no targets", async () => {
    const { deps, sent, calls } = createDeps({ listTargets: async () => [] });
    await sendTurnPush(input(), deps);
    assert.equal(sent.length, 0);
    assert.equal(calls.getSessionTitle, 0);
  });
});
