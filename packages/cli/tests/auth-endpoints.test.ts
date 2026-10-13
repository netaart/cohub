import { nativeFixtureHome } from "./fixtures/native-home.js";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { clearAuthSession, readAuthSession, requestDeviceCode, resolveAccessToken, verifyDeviceCode } from "../src/auth.js";

after(() => rm(nativeFixtureHome, { recursive: true, force: true }));

test("custom servers isolate login state and preserve default sessions", async (t) => {
  for (const key of ["ENV", "COHUB_BASE_URL", "COHUB_EXECUTION_TOKEN"] as const) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const directory = join(nativeFixtureHome, ".config", "cohub");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "auth.json"), JSON.stringify({
    schemaVersion: 1, env: "prod", issuer: "https://auth.example.test", clientId: "client", resource: "resource", scope: "openid",
    tokenType: "Bearer", accessToken: "default-token", refreshToken: "default-refresh", accessTokenExpiresAt: Date.now() + 3_600_000,
    createdAt: 1, updatedAt: 1,
  }));
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => Response.json(
    String(input).endsWith("/oidc/device/auth")
      ? { device_code: "device", user_code: "USER", verification_uri: "https://auth.example.test/verify", expires_in: 600 }
      : { access_token: "custom-token", refresh_token: "custom-refresh", token_type: "Bearer", expires_in: 3600 },
  ));
  process.env.COHUB_BASE_URL = "https://one.example.test";
  await assert.rejects(resolveAccessToken(), /Not authenticated/);
  await requestDeviceCode();
  process.env.COHUB_BASE_URL = "https://two.example.test";
  await assert.rejects(verifyDeviceCode(), /Device code not found/);
  process.env.COHUB_BASE_URL = "https://one.example.test/";
  await verifyDeviceCode();
  assert.equal(await resolveAccessToken(), "custom-token");
  process.env.COHUB_BASE_URL = "https://two.example.test";
  clearAuthSession();
  assert.equal(readAuthSession(), null);
  process.env.COHUB_BASE_URL = "https://one.example.test";
  assert.equal(await resolveAccessToken(), "custom-token");
  clearAuthSession();
  process.env.COHUB_BASE_URL = "";
  assert.equal(await resolveAccessToken(), "default-token");
});
