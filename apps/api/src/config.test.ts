import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { isHostAllowedBySuffix, parseApnsConfig } from "./config.js";

const DEFAULT_SUFFIXES = [".cohub.run", ".cohub.live"];

describe("isHostAllowedBySuffix", () => {
  it("matches the bare domain", () => {
    assert.equal(isHostAllowedBySuffix("cohub.run", DEFAULT_SUFFIXES), true);
    assert.equal(isHostAllowedBySuffix("cohub.live", DEFAULT_SUFFIXES), true);
  });

  it("matches subdomains", () => {
    assert.equal(isHostAllowedBySuffix("apps.cohub.run", DEFAULT_SUFFIXES), true);
    assert.equal(isHostAllowedBySuffix("s-abc-3000.cohub.live", DEFAULT_SUFFIXES), true);
    assert.equal(isHostAllowedBySuffix("anything.cohub.run", DEFAULT_SUFFIXES), true);
  });

  it("rejects unrelated hosts and suffix lookalikes", () => {
    assert.equal(isHostAllowedBySuffix("notcohub.run", DEFAULT_SUFFIXES), false);
    assert.equal(isHostAllowedBySuffix("cohub.run.evil.example", DEFAULT_SUFFIXES), false);
    assert.equal(isHostAllowedBySuffix("evilcohub.run", DEFAULT_SUFFIXES), false);
    assert.equal(isHostAllowedBySuffix("example.com", DEFAULT_SUFFIXES), false);
  });

  it("is case-insensitive", () => {
    assert.equal(isHostAllowedBySuffix("COHUB.RUN", DEFAULT_SUFFIXES), true);
    assert.equal(isHostAllowedBySuffix("Works.Cohub.Live", DEFAULT_SUFFIXES), true);
  });

  it("accepts suffixes with or without a leading dot", () => {
    assert.equal(isHostAllowedBySuffix("cohub.live", ["cohub.live"]), true);
    assert.equal(isHostAllowedBySuffix("s-1-3000.cohub.live", ["cohub.live"]), true);
    assert.equal(isHostAllowedBySuffix("cohub.live", [".cohub.live"]), true);
    assert.equal(isHostAllowedBySuffix("s-1-3000.cohub.live", [".cohub.live"]), true);
  });
});

describe("parseApnsConfig", () => {
  const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const complete = {
    APNS_KEY_ID: "KEY123",
    APNS_TEAM_ID: "TEAM123",
    APNS_PRIVATE_KEY: pem,
    APNS_TOPICS: "com.example.app, com.example.app.dev ,",
  };

  it("is disabled without a warning when nothing is set", () => {
    assert.deepEqual(parseApnsConfig({}), { apns: null });
    assert.deepEqual(parseApnsConfig({ APNS_KEY_ID: " ", APNS_TOPICS: "," }), { apns: null });
  });

  it("parses a complete configuration", () => {
    assert.deepEqual(parseApnsConfig(complete), {
      apns: {
        keyId: "KEY123",
        teamId: "TEAM123",
        privateKey: pem.trim(),
        topics: ["com.example.app", "com.example.app.dev"],
      },
    });
  });

  it("accepts literal \\n escapes in the private key", () => {
    const escaped = pem.trim().replace(/\n/g, "\\n");
    assert.equal(parseApnsConfig({ ...complete, APNS_PRIVATE_KEY: escaped }).apns?.privateKey, pem.trim());
  });

  it("warns and disables on a partial configuration", () => {
    const { apns, warning } = parseApnsConfig({ APNS_KEY_ID: "KEY123", APNS_TOPICS: "com.example.app" });
    assert.equal(apns, null);
    assert.equal(warning, "APNs push disabled: missing APNS_TEAM_ID, APNS_PRIVATE_KEY");
  });

  it("warns and disables on an invalid private key", () => {
    const { apns, warning } = parseApnsConfig({ ...complete, APNS_PRIVATE_KEY: "not a key" });
    assert.equal(apns, null);
    assert.match(warning ?? "", /APNS_PRIVATE_KEY/);
  });
});
