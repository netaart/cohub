import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generatedFiles, repositoryFile } from "./scripts/host-bridge-manifest.js";
import { NATIVE_APPS } from "./src/native-apps.js";
import {
  HOST_BRIDGE_CAPABILITIES,
  HOST_BRIDGE_METHODS,
  HOST_BRIDGE_VERSION,
  hostBridgeHelloSchema,
  hostBridgeMessageSchema,
  hostBridgeRequestSchema,
  hostBridgeResponseSchema,
} from "./src/host-bridge.js";

type EnvelopeFixture = {
  requests: { name: string; text: string; request: { id: string; method: string; params: unknown } | null }[];
  replies: { name: string; json: unknown }[];
  events: { name: string; json: unknown }[];
};
const envelope = JSON.parse(
  readFileSync(new URL("./fixtures/host-bridge.json", import.meta.url), "utf8"),
) as EnvelopeFixture;

const parseRequest = (text: string) => {
  try {
    const parsed = hostBridgeRequestSchema.safeParse(JSON.parse(text));
    return parsed.success ? { id: parsed.data.id, method: parsed.data.method, params: parsed.data.params ?? null } : null;
  } catch {
    return null;
  }
};

for (const { name, text, request } of envelope.requests) {
  test(`fixture request: ${name}`, () => assert.deepEqual(parseRequest(text), request));
}

for (const { name, json } of [...envelope.replies, ...envelope.events]) {
  test(`fixture message: ${name}`, () => assert.equal(hostBridgeMessageSchema.safeParse(json).success, true));
}

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

test("hello reads an unknown platform as unknown and ignores extra fields", () => {
  const parsed = hostBridgeHelloSchema.safeParse({
    type: "hello",
    version: 1,
    platform: "harmony",
    hostId: "install-1",
    capabilities: [],
    extra: true,
  });
  assert.deepEqual(parsed.success && parsed.data, {
    type: "hello",
    version: 1,
    platform: "unknown",
    hostId: "install-1",
    capabilities: [],
  });
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
  assert.equal(token.params.safeParse({ forceRefresh: "yes" }).success, false);
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

for (const [path, content] of Object.entries(generatedFiles())) {
  test(`${path} is current; run generate:host-bridge after changing the protocol`, () => {
    assert.equal(readFileSync(repositoryFile(path), "utf8"), content);
  });
}

test("the Android manifest leaves native-apps.json's browser-only paths to the browser", () => {
  const manifest = readFileSync(repositoryFile("apps/android/app/src/main/AndroidManifest.xml"), "utf8");
  const excluded = [...manifest.matchAll(/<uri-relative-filter-group android:allow="false">\s*<data android:path(Prefix|Pattern)="([^"]+)" \/>/g)].map(
    ([, kind, path]) => (kind === "Pattern" ? (path ?? "").replaceAll(".*", "*").replace(/\*$/, "") : path),
  );
  assert.deepEqual(excluded, NATIVE_APPS.paths.browserOnly);
});
