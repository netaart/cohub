import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAppGrantScopes } from "./app-grant-scopes.js";

const existing = { scopes: ["file.view"], revokedAt: null, expiresAt: new Date(2000) };
test("legacy consent still replaces scopes", () => {
  assert.deepEqual(resolveAppGrantScopes({ requested: ["session.view"], existing, now: 1000 }), ["session.view"]);
});
test("incremental consent retains live scopes without duplicates", () => {
  assert.deepEqual(new Set(resolveAppGrantScopes({ requested: ["session.view", "file.view"], existing, mode: "extend", now: 1000 })), new Set(["file.view", "session.view"]));
});
test("incremental consent never revives expired or revoked scopes", () => {
  for (const grant of [{ ...existing, revokedAt: new Date(500) }, { ...existing, expiresAt: new Date(1000) }]) {
    assert.deepEqual(resolveAppGrantScopes({ requested: ["session.view"], existing: grant, mode: "extend", now: 1000 }), ["session.view"]);
  }
});
