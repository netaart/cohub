import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_HOST_CONSENT_SCOPES,
  APP_SILENT_SHELL_SCOPES,
  isAppHostConsentScope,
  isAppSilentShellScope,
} from "./src/app-authorization.js";

test("Shell auto-authorization keeps the approved read-only scope set explicit", () => {
  assert.deepEqual(APP_SILENT_SHELL_SCOPES, [
    "space.view",
    "file.view",
    "file.view.filtered",
    "session.view",
    "taskrun.view",
    "checkpoint.view",
  ]);
  assert.equal(isAppSilentShellScope("file.view"), true);
  assert.equal(isAppSilentShellScope("checkpoint.view"), true);
  assert.equal(isAppSilentShellScope("file.edit"), false);
  assert.equal(isAppSilentShellScope("session.prompt.readonly"), false);
});

test("Host consent adds only file.edit to the read-only Shell scopes", () => {
  assert.deepEqual(APP_HOST_CONSENT_SCOPES, [...APP_SILENT_SHELL_SCOPES, "file.edit"]);
  assert.equal(isAppHostConsentScope("file.edit"), true);
  for (const scope of ["session.prompt.readonly", "session.prompt.fullaccess", "generation.create", "command.execute", "user.taskrun.list"]) {
    assert.equal(isAppHostConsentScope(scope), false, scope);
  }
});
