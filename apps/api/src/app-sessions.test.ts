import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { createAppSessionToken, isSignedAppSessionToken, verifyAppSessionToken } from "./app-sessions.js";

const SECRET = "test-app-encryption-key";
const mint = (input: Parameters<typeof createAppSessionToken>[0]) =>
  createAppSessionToken({ ...input, secret: SECRET });
const verify = (token: string) => verifyAppSessionToken(token, SECRET);

describe("app session tokens", () => {
  it("round-trips identity, publisher scopes, and the consent snapshot", () => {
    const principal = verify(mint({
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "home-space",
      appScopes: ["space.view"],
      viewerScopes: ["file.view"],
    }));
    assert.ok(principal);
    assert.equal(principal?.userUuid, "user-1");
    assert.equal(principal?.appId, "app-1");
    // Legacy flat claims stay in sync for JWT-inspecting clients.
    assert.deepEqual(principal?.appScopes, ["space.view"]);
    assert.deepEqual(principal?.workScopes, ["space.view"]);
    assert.deepEqual(principal?.viewerScopes, ["file.view"]);
    assert.deepEqual(principal?.scopes, ["space.view", "file.view"]);
  });

  it("clamps publisher scopes when minting and verifying tokens", () => {
    const minted = verify(mint({
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "home-space",
      appScopes: ["space.view", "file.edit", "session.prompt.readonly", "session.prompt.fullaccess", "command.execute", "member.manage", "sandbox.manage"],
    }));
    assert.deepEqual(minted?.appScopes, ["space.view", "file.edit", "session.prompt.readonly", "session.prompt.fullaccess", "command.execute"]);
    assert.deepEqual(minted?.scopes, ["space.view", "file.edit", "session.prompt.readonly", "session.prompt.fullaccess", "command.execute"]);

    const safe = mint({
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "home-space",
      appScopes: ["space.view"],
    });
    const [header] = safe.split(".");
    const payload = {
      typ: "app_session",
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "home-space",
      appScopes: ["member.manage"],
      workScopes: ["member.manage"],
      viewerScopes: [],
      scopes: ["member.manage"],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const signingInput = `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const signature = createHmac("sha256", SECRET).update(signingInput).digest().toString("base64url");
    const legacy = verify(`${signingInput}.${signature}`);
    assert.deepEqual(legacy?.appScopes, []);
    assert.deepEqual(legacy?.scopes, []);
  });

  it("omits viewer scopes for base session tokens", () => {
    const principal = verify(mint({
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "home-space",
      appScopes: ["space.view"],
    }));
    assert.ok(principal);
    assert.deepEqual(principal?.viewerScopes, []);
    assert.deepEqual(principal?.scopes, ["space.view"]);
  });

  it("keeps tokens constant-size regardless of how many spaces the viewer granted", () => {
    // The token deliberately carries no per-space grant refs — consent state
    // lives in app_viewer_grants and is resolved per request.
    const token = mint({
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "home-space",
      appScopes: ["space.view"],
      viewerScopes: ["file.view", "session.view"],
    });
    assert.ok(!token.includes("grantId"));
    assert.ok(!token.includes("viewerGrants"));
  });

  it("still verifies legacy single-grant tokens", () => {
    const legacy = mint({
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "home-space",
      appScopes: ["space.view"],
    });
    const [header] = legacy.split(".");
    const payload = {
      typ: "app_session",
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "home-space",
      appScopes: ["space.view"],
      workScopes: ["space.view"],
      viewerScopes: ["taskrun.view"],
      scopes: ["space.view", "taskrun.view"],
      appViewerGrantId: "legacy-grant",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const signingInput = `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const signature = createHmac("sha256", SECRET).update(signingInput).digest().toString("base64url");
    const principal = verify(`${signingInput}.${signature}`);
    assert.ok(principal);
    assert.deepEqual(principal?.viewerScopes, ["taskrun.view"]);
    assert.equal(principal?.scopes.includes("taskrun.view"), true);
  });

  it("rejects tampered and malformed tokens", () => {
    const token = mint({
      userUuid: "user-1",
      appId: "app-1",
      spaceId: "home-space",
      appScopes: ["space.view"],
    });
    assert.equal(verify(`${token}x`), null);
    assert.equal(verify("not-a-token"), null);
    assert.equal(verifyAppSessionToken(token, "other-secret"), null);
  });

  it("still recognizes an expired token as ours so callers cannot fall back to account access", () => {
    const expired = mint({ userUuid: "user-1", appId: "app-1", spaceId: "home-space", appScopes: [], ttlSeconds: -1 });
    assert.equal(verify(expired), null);
    assert.equal(isSignedAppSessionToken(expired, SECRET), true);
    assert.equal(isSignedAppSessionToken(`${expired}x`, SECRET), false);
  });
});
