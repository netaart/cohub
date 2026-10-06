import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOST_BRIDGE_CAPABILITIES,
  HOST_BRIDGE_METHODS,
  HOST_BRIDGE_VERSION,
  hostBridgeHelloSchema,
  hostBridgeResponseSchema,
} from "./src/host-bridge.js";

test("hello accepts every known capability and drops unknown ones", () => {
  const known = hostBridgeHelloSchema.safeParse({
    type: "hello",
    version: HOST_BRIDGE_VERSION,
    platform: "android",
    hostId: "install-1",
    capabilities: [...HOST_BRIDGE_CAPABILITIES],
  });
  assert.deepEqual(known.success && known.data.capabilities, [...HOST_BRIDGE_CAPABILITIES]);

  const newer = hostBridgeHelloSchema.safeParse({
    type: "hello",
    version: HOST_BRIDGE_VERSION,
    platform: "android",
    hostId: "install-1",
    capabilities: ["auth.token", "teleport"],
  });
  assert.deepEqual(newer.success && newer.data.capabilities, ["auth.token"]);
});

test("hello rejects unknown platforms and extra fields", () => {
  assert.equal(
    hostBridgeHelloSchema.safeParse({
      type: "hello",
      version: 1,
      platform: "harmony",
      hostId: "install-1",
      capabilities: [],
    }).success,
    false,
  );
  assert.equal(
    hostBridgeHelloSchema.safeParse({
      type: "hello",
      version: 1,
      platform: "android",
      hostId: "install-1",
      capabilities: [],
      extra: true,
    }).success,
    false,
  );
});

test("a newer host version still parses; version never gates calls", () => {
  assert.equal(
    hostBridgeHelloSchema.safeParse({
      type: "hello",
      version: HOST_BRIDGE_VERSION + 7,
      platform: "ios",
      hostId: "install-2",
      capabilities: ["auth.token"],
    }).success,
    true,
  );
});

test("response carries either a result or a well-formed error", () => {
  assert.equal(
    hostBridgeResponseSchema.safeParse({ type: "response", id: "req-1", result: "token" }).success,
    true,
  );
  assert.equal(
    hostBridgeResponseSchema.safeParse({
      type: "response",
      id: "req-1",
      error: { code: "canceled", message: "user dismissed" },
    }).success,
    true,
  );
  assert.equal(
    hostBridgeResponseSchema.safeParse({ type: "response", id: "req-1", error: { code: "" } }).success,
    false,
  );
});

test("every method validates its own params and result", () => {
  for (const [method, shape] of Object.entries(HOST_BRIDGE_METHODS)) {
    assert.ok(shape, method);
    assert.ok(shape.result, method);
  }

  const token = HOST_BRIDGE_METHODS["auth.getAccessToken"];
  assert.equal(token.params.safeParse({ forceRefresh: true }).success, true);
  assert.equal(token.params.safeParse({ force: true }).success, false);
  assert.equal(token.result.safeParse(null).success, true);
  assert.equal(token.result.safeParse("").success, false);

  // A hosted surface cannot read ID token claims, so the host must report the
  // identity that feeds the cache partition key.
  const session = HOST_BRIDGE_METHODS["auth.getSession"];
  assert.equal(
    session.result.safeParse({
      authenticated: true,
      userUuid: "u-1",
      subject: "sub-1",
      email: "a@b.c",
    }).success,
    true,
  );
  assert.equal(
    session.result.safeParse({ authenticated: true, userUuid: null, subject: null, email: null }).success,
    true,
  );
  assert.equal(session.result.safeParse({ authenticated: true }).success, false);
});
