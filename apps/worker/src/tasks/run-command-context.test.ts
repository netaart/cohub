import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";
import { appActionFailureMessage } from "./run-command-context.js";

describe("App Action command result", () => {
  it("accepts exit zero and ignores ordinary Run Commands", () => {
    assert.equal(appActionFailureMessage(APP_ACTION_EXECUTION_SOURCE, { exitCode: 0 }), null);
    assert.equal(appActionFailureMessage("run_command", { exitCode: 66 }), null);
  });

  it("maps non-zero and terminated Actions to Task failures", () => {
    assert.equal(
      appActionFailureMessage(APP_ACTION_EXECUTION_SOURCE, { exitCode: 66 }),
      "App Action exited with code 66.",
    );
    assert.equal(
      appActionFailureMessage(APP_ACTION_EXECUTION_SOURCE, {
        exitCode: null,
        termination: { reason: "timed_out", exitCode: null },
      }),
      "App Action timed out.",
    );
    assert.equal(
      appActionFailureMessage(APP_ACTION_EXECUTION_SOURCE, {
        exitCode: null,
        termination: { reason: "aborted", exitCode: null },
      }),
      "App Action was aborted.",
    );
  });

  it("keeps the output tail for diagnosis", () => {
    const tail = `${"x".repeat(3971)}\nError [ERR_MODULE_NOT_FOUND]`;
    assert.equal(
      appActionFailureMessage(APP_ACTION_EXECUTION_SOURCE, { exitCode: 1, output: `head\n${tail}\n` }),
      `App Action exited with code 1.\n${tail}`,
    );
  });
});
