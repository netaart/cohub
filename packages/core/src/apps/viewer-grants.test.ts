import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { delegatedAppAuthorization, readOfflineScopes, withOfflineScopes } from "./viewer-grants.js";

const publishedHomeApp = {
  status: "published",
  spaceId: "space-home",
  appScopes: ["space.view", "file.view"],
};

describe("delegatedAppAuthorization", () => {
  it("keeps the delegation active on the home space with live publisher scopes", () => {
    assert.deepEqual(delegatedAppAuthorization(publishedHomeApp, "space-home"), {
      active: true,
      appScopes: ["space.view", "file.view"],
    });
  });

  it("stays active across spaces with no app-side scopes — the viewer grant still applies", () => {
    // The core multi-space scenario: app home is space-home, the viewer
    // granted space-other. Killing the delegation here would make every
    // cross-space scheduled prompt fail.
    assert.deepEqual(delegatedAppAuthorization(publishedHomeApp, "space-other"), {
      active: true,
      appScopes: [],
    });
  });

  it("switches the whole delegation off when the app is disabled or missing", () => {
    assert.deepEqual(delegatedAppAuthorization({ ...publishedHomeApp, status: "disabled" }, "space-home"), {
      active: false,
    });
    assert.deepEqual(delegatedAppAuthorization(null, "space-home"), { active: false });
    assert.deepEqual(delegatedAppAuthorization(undefined, "space-home"), { active: false });
  });

  it("normalizes and clamps the publisher scopes", () => {
    assert.deepEqual(
      delegatedAppAuthorization(
        {
          status: "published",
          spaceId: "space-home",
          appScopes: ["file.view", "file.view", "file.edit", "session.prompt.fullaccess", "command.execute", "member.manage", "not-a-scope"],
        },
        "space-home",
      ),
      { active: true, appScopes: ["file.view", "file.edit", "session.prompt.fullaccess", "command.execute"] },
    );
  });
});

describe("offline scopes", () => {
  it("round-trips through grant meta without dropping provenance", () => {
    const meta = withOfflineScopes({ consent: "host" }, ["space.commerce.view", "space.view"]);
    assert.deepEqual(readOfflineScopes(meta), ["space.commerce.view", "space.view"]);
    assert.deepEqual(withOfflineScopes(meta, []), { consent: "host" });
    assert.equal(withOfflineScopes(null, []), null);
  });

  it("ignores rows that never consented to offline access", () => {
    assert.deepEqual(readOfflineScopes(null), []);
    assert.deepEqual(readOfflineScopes({ consent: "host" }), []);
    assert.deepEqual(readOfflineScopes({ offlineScopes: ["not-a-scope", 3] }), []);
  });
});
