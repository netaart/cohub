import assert from "node:assert/strict";
import test from "node:test";
import { taskBrowserScopes } from "./scope.ts";

test("prioritizes Session, Space, then Mine", () => {
  assert.deepEqual(
    taskBrowserScopes({
      surface: "app",
      source: "desktop_command",
      spaceId: "space-1",
      sessionId: "session-1",
    }),
    [
      { kind: "session", spaceId: "space-1", sessionId: "session-1" },
      { kind: "space", spaceId: "space-1" },
      { kind: "mine" },
    ],
  );
});

test("never falls back to the app's publishing space", () => {
  assert.deepEqual(taskBrowserScopes(undefined), [{ kind: "mine" }]);
  assert.deepEqual(taskBrowserScopes({ surface: "page" }), [{ kind: "mine" }]);
});
