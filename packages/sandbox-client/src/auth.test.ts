import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandboxRpcNonce, createSandboxRpcToken, resolveSandboxConnectionOptions, sandboxWsEndpoint, SandboxConnectionConfigError } from "./auth.js";

const signingKey = "test-platform-key";
const nonce = createSandboxRpcNonce();
const cloud = {
  provider: "cloud",
  meta: { podIp: "10.0.0.1", wsEndpoint: "ws://10.0.0.1:8788/sandbox", rpcTokenNonce: nonce },
};

test("RPC tokens are bound to the space and instance without publishing the bearer", () => {
  const token = createSandboxRpcToken(signingKey, "space-a", nonce);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createSandboxRpcToken(signingKey, "space-a", nonce), token);
  assert.notEqual(createSandboxRpcToken(signingKey, "space-b", nonce), token);
  assert.notEqual(createSandboxRpcToken(signingKey, "space-a", createSandboxRpcNonce()), token);
  assert.notEqual(createSandboxRpcToken("other-key", "space-a", nonce), token);
  assert.ok(!JSON.stringify(cloud.meta).includes(token));
});

test("cloud connections use only RPC authorization and reject invalid instance credentials", () => {
  const options = resolveSandboxConnectionOptions({ spaceId: "space-a", sandbox: cloud, signingKey, workerSecret: "global-secret" });
  assert.deepEqual(options.headers, { authorization: `Bearer ${createSandboxRpcToken(signingKey, "space-a", nonce)}` });
  for (const rpcTokenNonce of ["", "invalid", 42]) {
    assert.throws(() => resolveSandboxConnectionOptions({
      spaceId: "space-a", signingKey,
      sandbox: { ...cloud, meta: { ...cloud.meta, rpcTokenNonce } },
    }), /recreate the sandbox/);
  }
});

test("legacy cloud metadata without a nonce does not send any credential", () => {
  for (const meta of [
    { podIp: cloud.meta.podIp },
    { podIp: cloud.meta.podIp, wsEndpoint: "" },
    { podIp: cloud.meta.podIp, wsEndpoint: cloud.meta.wsEndpoint },
    { ...cloud.meta, rpcTokenNonce: null },
  ]) {
    const options = resolveSandboxConnectionOptions({
      spaceId: "space-a", signingKey, workerSecret: "global-secret",
      sandbox: { provider: "cloud", meta },
    });
    assert.deepEqual(options, { wsUrl: cloud.meta.wsEndpoint, headers: {} });
  }
});

test("Pod-IP-only authenticated instances still send their RPC credential", () => {
  const options = resolveSandboxConnectionOptions({
    spaceId: "space-a", signingKey,
    sandbox: { provider: "cloud", meta: { podIp: cloud.meta.podIp, rpcTokenNonce: nonce } },
  });
  assert.deepEqual(options, {
    wsUrl: cloud.meta.wsEndpoint,
    headers: { authorization: `Bearer ${createSandboxRpcToken(signingKey, "space-a", nonce)}` },
  });
});

test("connection configuration failures have an explicit error type", () => {
  for (const meta of [{}, { podIp: "invalid" }, { ...cloud.meta, wsEndpoint: "not-a-url" }, { ...cloud.meta, rpcTokenNonce: "invalid" }]) {
    assert.throws(() => resolveSandboxConnectionOptions({ spaceId: "space-a", signingKey, sandbox: { provider: "cloud", meta } }), SandboxConnectionConfigError);
  }
});

test("a cloud endpoint cannot select worker credentials or a different destination", () => {
  for (const wsEndpoint of [
    "ws://attacker.test/internal/sandbox-relay/space-a",
    "ws://10.0.0.2:8788/sandbox",
    "ws://10.0.0.1:8788/sandbox?token=leak",
    "ws://user:secret@10.0.0.1:8788/sandbox",
    "http://10.0.0.1:8788/sandbox",
  ]) {
    assert.throws(() => resolveSandboxConnectionOptions({
      spaceId: "space-a", signingKey, workerSecret: "global-secret",
      sandbox: { ...cloud, meta: { ...cloud.meta, wsEndpoint } },
    }));
  }
});

test("local relay authorization is selected by provider and exact space path", () => {
  const input = {
    spaceId: "space-a", signingKey, workerSecret: "relay-secret",
    sandbox: { provider: "local", meta: { wsEndpoint: "ws://gateway.test:8788/internal/sandbox-relay/space-a" } },
  };
  assert.deepEqual(resolveSandboxConnectionOptions(input).headers, { "x-worker-secret": "relay-secret" });
  assert.throws(() => resolveSandboxConnectionOptions({ ...input, spaceId: "space-b" }));
  assert.throws(() => resolveSandboxConnectionOptions({ ...input, workerSecret: undefined }));
  assert.equal(sandboxWsEndpoint("2001:db8::1"), "ws://[2001:db8::1]:8788/sandbox");
});
