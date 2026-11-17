import assert from "node:assert/strict";
import test from "node:test";
import { accessRequestFor } from "./access.ts";

test("session and space scopes target their own space", () => {
  for (const scope of [
    { kind: "session", spaceId: "space-1", sessionId: "session-1" },
    { kind: "space", spaceId: "space-1" },
  ] as const) {
    const request = accessRequestFor(scope);
    assert.deepEqual(request.scopes, ["taskrun.view"]);
    assert.equal(request.spaceId, "space-1");
  }
});

test("mine scope asks for the account-level task list", () => {
  const request = accessRequestFor({ kind: "mine" });
  assert.deepEqual(request.scopes, ["user.taskrun.list"]);
  assert.equal(request.spaceId, undefined);
});
