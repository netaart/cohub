import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertRequiredConfig, config as workerConfig, resolveGiteaConfig } from "../src/config.js";

const validConfig = {
  ...workerConfig,
  redisUrl: "redis://localhost:6379",
  bullmqRedisUrl: "redis://localhost:6379",
  databaseUrl: "postgres://localhost/cohub-test",
  workerSecret: "test-worker-secret",
  appEncryptionKey: "test-encryption-key",
  spaceStorageRoot: "/tmp/cohub-test/spaces",
  spaceSystemRoot: "/tmp/cohub-test/system",
  checkpointCacheRoot: "/tmp/cohub-test/checkpoints",
};

describe("Gitea mirror configuration", () => {
  it("disables the mirror when Gitea is not configured", () => {
    const config = resolveGiteaConfig({});
    assert.equal(config.giteaBaseUrl, undefined);
    assert.equal(config.giteaToken, undefined);
    assert.equal(config.giteaOrg, "cohub-spaces");
    assert.doesNotThrow(() => assertRequiredConfig({ ...validConfig, ...config }));
  });

  it("normalizes a complete legacy Gitea configuration", () => {
    const config = resolveGiteaConfig({
      GITEA_BASE_URL: " https://git.example.com/ ",
      GITEA_TOKEN: " token ",
      GITEA_ORG: " self-hosted ",
    });
    assert.deepEqual(config, {
      giteaBaseUrl: "https://git.example.com",
      giteaToken: "token",
      giteaOrg: "self-hosted",
    });
    assert.doesNotThrow(() => assertRequiredConfig({ ...validConfig, ...config }));
  });

  it("rejects incomplete configuration at startup", () => {
    for (const source of [
      { GITEA_BASE_URL: "https://git.example.com" },
      { GITEA_TOKEN: "token" },
    ]) {
      assert.throws(
        () => assertRequiredConfig({ ...validConfig, ...resolveGiteaConfig(source) }),
        /GITEA_BASE_URL and GITEA_TOKEN must be configured together/,
      );
    }
  });
});
