import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, it } from "node:test";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import {
  APNS_PROVIDER_TOKEN_REFRESH_MS,
  ApnsProviderToken,
  createApnsClient,
  truncateUtf8,
  type ApnsTarget,
  type ApnsTransport,
  type ApnsTransportRequest,
  type ApnsTransportResponse,
} from "./apns.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

const target = (overrides: Partial<ApnsTarget> = {}): ApnsTarget => ({
  token: "a".repeat(64),
  environment: "production",
  topic: "com.example.app",
  ...overrides,
});

const createFakeTransport = (respond: (request: ApnsTransportRequest) => ApnsTransportResponse | Promise<ApnsTransportResponse>) => {
  const requests: ApnsTransportRequest[] = [];
  const transport: ApnsTransport = {
    request: async (request) => {
      requests.push(request);
      return respond(request);
    },
    close: () => {},
  };
  return { transport, requests };
};

const createLogSink = () => {
  const entries: Array<{ level: "warn" | "error"; message: unknown; meta: unknown }> = [];
  return {
    entries,
    logger: {
      warn: (message: unknown, meta?: unknown) => entries.push({ level: "warn", message, meta }),
      error: (message: unknown, meta?: unknown) => entries.push({ level: "error", message, meta }),
    },
  };
};

const fixedProviderToken = () => {
  let invalidated = 0;
  return {
    get invalidated() {
      return invalidated;
    },
    get: async () => "provider-jwt",
    invalidate: () => {
      invalidated += 1;
    },
  };
};

const createClient = (respond: Parameters<typeof createFakeTransport>[0]) => {
  const { transport, requests } = createFakeTransport(respond);
  const deleted: ApnsTarget[] = [];
  const logs = createLogSink();
  const providerToken = fixedProviderToken();
  const client = createApnsClient({
    providerToken,
    topics: ["com.example.app"],
    transport,
    deleteTarget: async (value) => {
      deleted.push(value);
    },
    logger: logs.logger,
  });
  return { client, requests, deleted, logs, providerToken };
};

describe("ApnsProviderToken", () => {
  const verify = (token: string, key: KeyObject) => jwtVerify(token, key, { algorithms: ["ES256"] });

  it("signs an ES256 token with kid, iss and iat", async () => {
    const nowMs = 1_790_000_000_000;
    const provider = new ApnsProviderToken({ keyId: "KEY123", teamId: "TEAM123", privateKey, now: () => nowMs });
    const token = await provider.get();
    assert.deepEqual(decodeProtectedHeader(token), { alg: "ES256", kid: "KEY123" });
    assert.deepEqual(decodeJwt(token), { iss: "TEAM123", iat: nowMs / 1000 });
    await verify(token, publicKey);
  });

  it("accepts the PEM string form of the key", async () => {
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const provider = new ApnsProviderToken({ keyId: "K", teamId: "T", privateKey: pem });
    await verify(await provider.get(), publicKey);
  });

  it("reuses the token until the refresh window, then re-signs", async () => {
    let nowMs = 1_790_000_000_000;
    const provider = new ApnsProviderToken({ keyId: "K", teamId: "T", privateKey, now: () => nowMs });
    const first = await provider.get();
    nowMs += APNS_PROVIDER_TOKEN_REFRESH_MS - 1;
    assert.equal(await provider.get(), first);
    nowMs += 1;
    const second = await provider.get();
    assert.notEqual(second, first);
    assert.equal(decodeJwt(second).iat, Math.floor(nowMs / 1000));
  });

  it("refreshes well inside Apple's 20-60 minute window", () => {
    assert.ok(APNS_PROVIDER_TOKEN_REFRESH_MS > 20 * 60 * 1000);
    assert.ok(APNS_PROVIDER_TOKEN_REFRESH_MS < 60 * 60 * 1000);
  });

  it("shares one signature between concurrent callers", async () => {
    const provider = new ApnsProviderToken({ keyId: "K", teamId: "T", privateKey, now: () => 1_790_000_000_000 });
    const [a, b] = await Promise.all([provider.get(), provider.get()]);
    assert.equal(a, b);
  });

  it("re-signs after invalidate", async () => {
    let nowMs = 1_790_000_000_000;
    const provider = new ApnsProviderToken({ keyId: "K", teamId: "T", privateKey, now: () => nowMs });
    const first = await provider.get();
    nowMs += 1000;
    provider.invalidate();
    assert.notEqual(await provider.get(), first);
  });
});

describe("createApnsClient", () => {
  const notification = {
    payload: { aps: { alert: { title: "t" } } },
    collapseId: "turn-1",
    expiresAt: 1_790_086_400,
  };

  it("sends one request per target with APNs headers", async () => {
    const { client, requests, deleted } = createClient(() => ({ status: 200, body: "" }));
    await client.send([target(), target({ token: "b".repeat(64), environment: "sandbox" })], notification);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], {
      origin: "https://api.push.apple.com",
      path: `/3/device/${"a".repeat(64)}`,
      headers: {
        authorization: "bearer provider-jwt",
        "apns-topic": "com.example.app",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": "turn-1",
        "apns-expiration": "1790086400",
      },
      body: JSON.stringify(notification.payload),
      timeoutMs: 10_000,
    });
    assert.equal(requests[1]?.origin, "https://api.sandbox.push.apple.com");
    assert.deepEqual(deleted, []);
  });

  it("truncates the collapse id to 64 bytes", async () => {
    const { client, requests } = createClient(() => ({ status: 200, body: "" }));
    await client.send([target()], { ...notification, collapseId: "x".repeat(80) });
    assert.equal(requests[0]?.headers["apns-collapse-id"], "x".repeat(64));
  });

  it("deletes the target on 410 Unregistered", async () => {
    const { client, deleted } = createClient(() => ({ status: 410, body: JSON.stringify({ reason: "Unregistered", timestamp: 1 }) }));
    await client.send([target()], notification);
    assert.deepEqual(deleted, [target()]);
  });

  for (const reason of ["BadDeviceToken", "DeviceTokenNotForTopic"]) {
    it(`deletes the target on 400 ${reason}`, async () => {
      const { client, deleted } = createClient(() => ({ status: 400, body: JSON.stringify({ reason }) }));
      await client.send([target()], notification);
      assert.deepEqual(deleted, [target()]);
    });
  }

  it("keeps the target and logs other rejections", async () => {
    const { client, deleted, logs } = createClient(() => ({ status: 429, body: JSON.stringify({ reason: "TooManyRequests" }) }));
    await client.send([target()], notification);
    assert.deepEqual(deleted, []);
    assert.equal(logs.entries.length, 1);
    assert.equal(logs.entries[0]?.level, "error");
  });

  it("invalidates the provider token on ExpiredProviderToken", async () => {
    const { client, deleted, providerToken } = createClient(() => ({ status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) }));
    await client.send([target()], notification);
    assert.equal(providerToken.invalidated, 1);
    assert.deepEqual(deleted, []);
  });

  it("never throws when the transport fails", async () => {
    const { client, logs } = createClient(() => {
      throw new Error("APNs request timed out after 10000ms");
    });
    await client.send([target()], notification);
    assert.equal(logs.entries[0]?.level, "error");
  });

  it("keeps delivering to other targets when one fails", async () => {
    const { client, requests } = createClient((request) => {
      if (request.path.endsWith("a".repeat(64))) throw new Error("boom");
      return { status: 200, body: "" };
    });
    await client.send([target(), target({ token: "b".repeat(64) })], notification);
    assert.equal(requests.length, 2);
  });

  it("skips targets whose topic is no longer configured", async () => {
    const { client, requests, deleted } = createClient(() => ({ status: 200, body: "" }));
    await client.send([target({ topic: "com.example.removed" })], notification);
    assert.equal(requests.length, 0);
    assert.deepEqual(deleted, []);
  });
});

describe("truncateUtf8", () => {
  it("keeps short values", () => {
    assert.equal(truncateUtf8("turn-1", 64), "turn-1");
  });

  it("never splits a multi-byte character", () => {
    const value = "é".repeat(40);
    const truncated = truncateUtf8(value, 64);
    assert.equal(truncated, "é".repeat(32));
    assert.equal(truncateUtf8(`a${"é".repeat(40)}`, 64), `a${"é".repeat(31)}`);
  });
});
