import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUserPreferencesPatch, parseUserPreferences, parseUserPreferencesPatch, patchStoredUserPreferences, shouldNotifyTurn } from "./dist/notifications.js";

const CRON = "33333333-3333-4333-8333-333333333333";

test("a task's own setting wins over the global switch; only successes are silenced", () => {
  const prefs = (patch: Parameters<typeof applyUserPreferencesPatch>[1]) =>
    applyUserPreferencesPatch(parseUserPreferences(null), patch).notifications;
  const globalOff = prefs({ notifications: { success: { scheduled: false }, cronJobs: { [CRON]: true } } });
  assert.equal(shouldNotifyTurn(globalOff, { status: "completed", source: "scheduled", cronJobId: CRON }), true);
  assert.equal(shouldNotifyTurn(globalOff, { status: "completed", source: "scheduled", cronJobId: null }), false);
  assert.equal(shouldNotifyTurn(globalOff, { status: "failed", source: "scheduled", cronJobId: null }), true);
  const taskOff = prefs({ notifications: { cronJobs: { [CRON]: false } } });
  assert.equal(shouldNotifyTurn(taskOff, { status: "completed", source: "scheduled", cronJobId: CRON }), false);
  assert.equal(shouldNotifyTurn(taskOff, { status: "interrupted", source: "scheduled", cronJobId: CRON }), true);
  assert.equal(shouldNotifyTurn(prefs({ notifications: { success: { hook: false } } }), { status: "completed", source: "chat" }), true);
});

test("writes touch only the named fields; patches are strict and task ids canonical", () => {
  const upper = CRON.toUpperCase();
  const patch = parseUserPreferencesPatch({ notifications: { cronJobs: { [upper]: false } } });
  assert.deepEqual(patch, { notifications: { cronJobs: { [CRON]: false } } });
  const stored = { theme: "dark", notifications: { digest: "daily", success: { future: false, hook: true }, cronJobs: { future: { mode: "digest" } } } };
  const data = patchStoredUserPreferences(stored, patch);
  assert.deepEqual(data, {
    theme: "dark",
    notifications: { digest: "daily", success: { future: false, hook: true }, cronJobs: { future: { mode: "digest" }, [CRON]: false } },
  });
  assert.equal(shouldNotifyTurn(parseUserPreferences(data).notifications, { status: "completed", source: "scheduled", cronJobId: upper }), false);
  assert.throws(() => parseUserPreferencesPatch({ notifications: { succes: { scheduled: false } } }), /notifications\.succes is not a known field/);
  assert.throws(() => parseUserPreferencesPatch({ notification: {} }), /preferences\.notification is not a known field/);
});
