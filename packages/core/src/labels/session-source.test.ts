import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getSessionSourceLabelSystemKey,
  resolveKnownSessionSourceLabelSystemKey,
  resolveSessionSourceKey,
  resolveSessionSourceLabelRef,
  SESSION_SOURCE_KEYS,
  sessionSourceRawValues,
} from "./session-source.js";

test("resolveSessionSourceLabelRef maps known channel providers", () => {
  assert.equal(resolveSessionSourceLabelRef({ provider: "qq" }), "Source/QQ");
  assert.equal(resolveSessionSourceLabelRef({ provider: "wechat" }), "Source/WeChat");
  assert.equal(resolveSessionSourceLabelRef({ provider: "discord" }), "Source/Discord");
  assert.equal(resolveSessionSourceLabelRef({ provider: "feishu" }), "Source/Feishu");
});

test("resolveSessionSourceLabelRef maps channel-prefixed source strings", () => {
  assert.equal(resolveSessionSourceLabelRef({ source: "qq:c2c:12345" }), "Source/QQ");
  assert.equal(resolveSessionSourceLabelRef({ source: "channel:qq" }), "Source/QQ");
  assert.equal(resolveSessionSourceLabelRef({ source: "wechat:user-1" }), "Source/WeChat");
});

test("resolveSessionSourceLabelRef prefers provider over source", () => {
  assert.equal(
    resolveSessionSourceLabelRef({ provider: "qq", source: "discord:ignored" }),
    "Source/QQ",
  );
});

test("resolveSessionSourceLabelRef falls back to Other for unknown sources", () => {
  assert.equal(resolveSessionSourceLabelRef({ source: null }), "Source/Other");
  assert.equal(resolveSessionSourceLabelRef({ source: "mystery" }), "Source/Other");
  assert.equal(resolveSessionSourceLabelRef({ provider: "unknown" }), "Source/Other");
});

test("resolveKnownSessionSourceLabelSystemKey covers QQ", () => {
  assert.equal(
    resolveKnownSessionSourceLabelSystemKey("Source/QQ"),
    getSessionSourceLabelSystemKey("qq"),
  );
  assert.equal(resolveKnownSessionSourceLabelSystemKey("Source/Other"), null);
});

test("resolveSessionSourceKey collapses label aliases and defaults null to web", () => {
  assert.equal(resolveSessionSourceKey(null), "web");
  assert.equal(resolveSessionSourceKey(undefined), "web");
  assert.equal(resolveSessionSourceKey("web"), "web");
  assert.equal(resolveSessionSourceKey("web_app"), "web");
  assert.equal(resolveSessionSourceKey("Scheduled_Task"), "scheduled_task");
  assert.equal(resolveSessionSourceKey("qq:c2c:12345"), "qq");
  assert.equal(resolveSessionSourceKey("channel:discord"), "discord");
  assert.equal(resolveSessionSourceKey("mystery"), "other");
});

test("sessionSourceRawValues returns every raw alias of a kind", () => {
  assert.deepEqual(new Set(sessionSourceRawValues("web")), new Set(["web", "web_app"]));
  assert.deepEqual(sessionSourceRawValues("qq"), ["qq"]);
  assert.deepEqual(sessionSourceRawValues("other"), []);
});

test("SESSION_SOURCE_KEYS lists each kind once, other last", () => {
  assert.equal(SESSION_SOURCE_KEYS.at(-1), "other");
  assert.equal(new Set(SESSION_SOURCE_KEYS).size, SESSION_SOURCE_KEYS.length);
  assert.ok(SESSION_SOURCE_KEYS.includes("web"));
  assert.equal(SESSION_SOURCE_KEYS.includes("web_app"), false);
  for (const key of SESSION_SOURCE_KEYS) {
    assert.ok(SESSION_SOURCE_KEYS.includes(resolveSessionSourceKey(key)));
  }
});

// Kinds must stay limited to what a space can actually produce. A label for a
// provider with no gateway implementation would only offer an empty filter.
test("SESSION_SOURCE_KEYS covers the non-channel kinds and the real providers", () => {
  const chatProviders = ["discord", "feishu", "qq", "wechat"];
  for (const key of [
    "web",
    "cli",
    "public_api",
    "scheduled_task",
    "space_hook",
    "websocket",
    "other",
    ...chatProviders,
  ]) {
    assert.ok(SESSION_SOURCE_KEYS.includes(key), `missing source kind: ${key}`);
  }
  assert.equal(SESSION_SOURCE_KEYS.length, 7 + chatProviders.length);
});
