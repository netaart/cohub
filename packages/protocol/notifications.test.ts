import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUserPreferencesPatch, parseUserPreferences, shouldNotifyTurn } from "./dist/notifications.js";

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
