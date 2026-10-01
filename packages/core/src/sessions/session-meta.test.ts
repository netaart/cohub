import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inheritSessionMetaForFork,
  canClaimSessionFallbackTitle,
  normalizeSessionTitle,
  readSessionTitleSource,
  setSessionTitleMeta,
} from "./session-meta.js";

test("forks inherit settings but not their parent's creation provenance", () => {
  const parent = { origin: { turnId: "creator" }, requestSource: { turnId: "creator" }, setting: "keep" };
  assert.deepEqual(inheritSessionMetaForFork(parent), { setting: "keep" });
  assert.deepEqual(parent.origin, { turnId: "creator" });
  assert.deepEqual(inheritSessionMetaForFork(null), {});
});

test("normalizes session titles to the database limit", () => {
  assert.equal(normalizeSessionTitle("  Build   a title  "), "Build a title");
  assert.equal(Array.from(normalizeSessionTitle("界".repeat(300)) ?? "").length, 255);
  assert.equal(normalizeSessionTitle("   "), null);
});

test("does not claim a title that the user explicitly cleared", () => {
  const userMeta = setSessionTitleMeta({}, { source: "user" });
  assert.equal(canClaimSessionFallbackTitle(null, userMeta), false);
  assert.equal(canClaimSessionFallbackTitle(null, {}), true);
  assert.equal(canClaimSessionFallbackTitle("Existing", {}), false);
});

test("updates title provenance without dropping unrelated session metadata", () => {
  const meta = setSessionTitleMeta(
    { participants: { version: 1 }, title: { source: "fallback" } },
    {
      source: "generated",
      model: "cohub/title",
      configRevision: "rev-1",
      rawOutput: "Generated title",
      usage: { output: 4 },
    },
  );

  assert.equal(readSessionTitleSource(meta), "generated");
  assert.deepEqual(meta.participants, { version: 1 });
  assert.deepEqual(meta.title, {
    source: "generated",
    model: "cohub/title",
    configRevision: "rev-1",
    rawOutput: "Generated title",
    usage: { output: 4 },
  });
});
