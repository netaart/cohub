import assert from "node:assert/strict";
import { it } from "node:test";
import { ROLE_PERMISSIONS, isUserLevelPermission } from "./index.js";

it("space.create is account-level, never a role permission", () => {
  assert.ok(isUserLevelPermission("space.create"));
  for (const role of Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>) {
    assert.ok(!ROLE_PERMISSIONS[role].has("space.create"));
  }
});

// Publishing an App is a builder capability: hosts and builders may publish,
// while guests may not.
it("app publishing is a host and builder capability", () => {
  assert.ok(ROLE_PERMISSIONS.host.has("app.publish"));
  assert.ok(ROLE_PERMISSIONS.builder.has("app.publish"));
  assert.ok(!ROLE_PERMISSIONS.guest.has("app.publish"));
});

// Session sharing is gated on the dedicated `session.access.manage` permission:
// builders and hosts may share a session, while member management stays host-only.
it("session sharing is a builder capability, member management is not", () => {
  assert.ok(ROLE_PERMISSIONS.builder.has("session.access.manage"));
  assert.ok(ROLE_PERMISSIONS.builder.has("session.view"));
  assert.ok(!ROLE_PERMISSIONS.builder.has("member.manage"));
  assert.ok(ROLE_PERMISSIONS.host.has("session.access.manage"));
  assert.ok(ROLE_PERMISSIONS.host.has("member.manage"));
  assert.ok(!ROLE_PERMISSIONS.guest.has("session.access.manage"));
});
