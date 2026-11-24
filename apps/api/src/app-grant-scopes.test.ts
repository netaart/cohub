import assert from "node:assert/strict";
import { test } from "node:test";
import type { Permission } from "@cohub/core/permissions";
import { canRenewGrantSilently, hostConsentRefused, parseAppAuthorizeRequest, resolveAppGrantScopes, resolveOfflineGrantScopes } from "./app-grant-scopes.js";

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

const ALLOWED = new Set<Permission>(["file.view", "file.edit", "session.view", "session.prompt.fullaccess"]);

test("host consent is capped at read-only scopes plus file.edit", () => {
  assert.deepEqual(parseAppAuthorizeRequest({ scopes: ["file.view", "file.edit", "file.view"], consent: "host" }, ALLOWED), {
    requested: ["file.view", "file.edit"],
    extend: true,
    hostConsent: true,
    offline: false,
  });
  assert.equal("message" in parseAppAuthorizeRequest({ scopes: ["file.edit", "session.prompt.fullaccess"], consent: "host" }, ALLOWED), true);
  assert.equal("requested" in parseAppAuthorizeRequest({ scopes: ["session.prompt.fullaccess"] }, ALLOWED), true);
});

test("host consent rejects unknown consent values and unknown scopes", () => {
  assert.deepEqual(parseAppAuthorizeRequest({ scopes: ["file.view"], consent: "viewer" }, ALLOWED), { code: "invalid_request", message: "invalid consent" });
  assert.equal((parseAppAuthorizeRequest({ scopes: ["file.view", "nope"], consent: "host" }, ALLOWED) as { code?: string }).code, "invalid_scope");
  assert.deepEqual((parseAppAuthorizeRequest({ scopes: ["file.view", "nope"] }, ALLOWED) as { requested: Permission[] }).requested, ["file.view"]);
});

test("host consent only widens a live grant and never revives a revoked one", () => {
  const live = { scopes: ["session.view"], revokedAt: null, expiresAt: new Date(2000) };
  assert.deepEqual(new Set(resolveAppGrantScopes({ requested: ["file.view"], existing: live, mode: "extend", now: 1000 })), new Set(["session.view", "file.view"]));
  assert.equal(hostConsentRefused(true, { revokedAt: new Date(500) }), true);
  assert.equal(hostConsentRefused(true, { revokedAt: null }), false);
  assert.equal(hostConsentRefused(false, { revokedAt: new Date(500) }), false, "a dialog consent may revive it");
});

test("offline access needs the viewer's own consent for Space scopes", () => {
  assert.equal((parseAppAuthorizeRequest({ scopes: ["file.view"], offline: true }, ALLOWED) as { offline: boolean }).offline, true);
  assert.equal("message" in parseAppAuthorizeRequest({ scopes: ["file.view"], offline: true, consent: "host" }, ALLOWED), true);
  assert.equal("message" in parseAppAuthorizeRequest({ scopes: ["file.view"], offline: "yes" }, ALLOWED), true);
  assert.equal("message" in parseAppAuthorizeRequest({ scopes: ["user.space.list"], offline: true }, new Set<Permission>(["user.space.list"])), true);
});

test("only an offline consent changes offline scopes, and revocation clears them", () => {
  const offline = { scopes: ["file.view"], revokedAt: null, expiresAt: new Date(2000), meta: { offlineScopes: ["file.view"] } };
  assert.deepEqual(resolveOfflineGrantScopes({ requested: ["session.view"], offline: false, mode: "extend", existing: offline }), ["file.view"]);
  assert.deepEqual(resolveOfflineGrantScopes({ requested: ["session.view"], offline: true, mode: "extend", existing: offline }), ["file.view", "session.view"]);
  assert.deepEqual(resolveOfflineGrantScopes({ requested: ["session.view"], offline: true, existing: offline }), ["session.view"]);
  assert.deepEqual(resolveOfflineGrantScopes({ requested: ["session.view"], offline: false, existing: { ...offline, revokedAt: new Date(500) } }), []);
});

test("silent renewal never uses offline consent to restore or widen the interactive grant", () => {
  const offline = { scopes: ["file.view"], revokedAt: null, expiresAt: new Date(2000), meta: { offlineScopes: ["file.view", "file.edit"] } };
  assert.equal(canRenewGrantSilently({ existing: offline, requested: ["file.view"], offline: true, now: 1000 }), true);
  assert.equal(canRenewGrantSilently({ existing: offline, requested: ["file.edit"], offline: false, now: 1000 }), false, "no widening");
  assert.equal(canRenewGrantSilently({ existing: offline, requested: ["file.view"], offline: false, now: 3000 }), false, "no revival");
  assert.equal(canRenewGrantSilently({ existing: { ...offline, meta: null }, requested: ["file.view"], offline: true, now: 1000 }), false, "a 14-day grant cannot become offline silently");
  assert.equal(canRenewGrantSilently({ existing: { ...offline, revokedAt: new Date(800) }, requested: ["file.view"], offline: false, now: 1000 }), false);
});
