import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  countUserSessionsBySource,
  InvalidSessionListCursorError,
  InvalidSessionSourceFilterError,
  mergeUserSessionListBranches,
  parseSessionSourceKeys,
  pickSessionsPreservingOrder,
} from "./session-list.js";

const session = (id: string, lastMessageAt: string | null) => ({
  id,
  lastMessageAt: lastMessageAt ? new Date(lastMessageAt) : null,
});

describe("mergeUserSessionListBranches", () => {
  it("merges creator and participant branches by recent activity", () => {
    const creator = [
      session("c1", "2026-07-12T10:00:00.000Z"),
      session("c2", "2026-07-12T08:00:00.000Z"),
    ];
    const participant = [
      session("p1", "2026-07-12T11:00:00.000Z"),
      session("p2", "2026-07-12T09:00:00.000Z"),
    ];

    const page = mergeUserSessionListBranches([creator, participant], 3);
    assert.deepEqual(
      page.sessions.map((row) => row.id),
      ["p1", "c1", "p2"],
    );
    assert.equal(page.pageInfo.hasMore, true);
    assert.equal(page.pageInfo.nextCursor, encodeSessionListCursor(page.sessions.at(-1)));
  });

  it("dedupes by session id across branches", () => {
    const shared = session("s1", "2026-07-12T12:00:00.000Z");
    const page = mergeUserSessionListBranches([[shared], [shared, session("p1", "2026-07-12T11:00:00.000Z")]], 10);
    assert.deepEqual(
      page.sessions.map((row) => row.id),
      ["s1", "p1"],
    );
    assert.equal(page.pageInfo.hasMore, false);
    assert.equal(page.pageInfo.nextCursor, null);
  });

  it("keeps null lastMessageAt after timed rows (NULLS LAST)", () => {
    const page = mergeUserSessionListBranches(
      [
        [session("null-a", null), session("timed", "2026-07-12T01:00:00.000Z")],
        [session("null-b", null)],
      ],
      10,
    );
    assert.deepEqual(
      page.sessions.map((row) => row.id),
      ["timed", "null-b", "null-a"],
    );
  });

  it("breaks ties by id DESC when activity timestamps match", () => {
    const stamp = "2026-07-12T05:00:00.000Z";
    const page = mergeUserSessionListBranches(
      [
        [session("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", stamp)],
        [session("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", stamp)],
      ],
      10,
    );
    assert.deepEqual(
      page.sessions.map((row) => row.id),
      ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    );
  });
});

describe("pickSessionsPreservingOrder", () => {
  it("keeps the original activity order across spaces", () => {
    const ordered = [
      { id: "s-new", spaceId: "space-b" },
      { id: "s-mid", spaceId: "space-a" },
      { id: "s-old", spaceId: "space-b" },
    ];
    // Visible set is built by space buckets (A then B) — must not reshuffle output.
    const visibleIds = new Set(["s-old", "s-new", "s-mid"]);
    assert.deepEqual(
      pickSessionsPreservingOrder(ordered, visibleIds).map((row) => row.id),
      ["s-new", "s-mid", "s-old"],
    );
  });

  it("drops rows missing from the visibility set without reordering survivors", () => {
    const ordered = [
      { id: "a" },
      { id: "hidden" },
      { id: "b" },
      { id: "c" },
    ];
    assert.deepEqual(
      pickSessionsPreservingOrder(ordered, new Set(["c", "a", "b"])).map((row) => row.id),
      ["a", "b", "c"],
    );
  });
});

describe("decodeSessionListCursor", () => {
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  it("returns null for missing or blank cursors", () => {
    assert.equal(decodeSessionListCursor(null), null);
    assert.equal(decodeSessionListCursor(undefined), null);
    assert.equal(decodeSessionListCursor(""), null);
    assert.equal(decodeSessionListCursor("   "), null);
  });

  it("parses timed and null-activity cursors", () => {
    assert.deepEqual(decodeSessionListCursor(`2026-07-12T10:00:00.000Z|${id}`), {
      date: new Date("2026-07-12T10:00:00.000Z"),
      id,
    });
    assert.deepEqual(decodeSessionListCursor(`null|${id}`), {
      date: null,
      id,
    });
  });

  it("round-trips encode → decode", () => {
    const timed = encodeSessionListCursor(session(id, "2026-07-12T10:00:00.000Z"));
    const idle = encodeSessionListCursor(session(id, null));
    assert.deepEqual(decodeSessionListCursor(timed), {
      date: new Date("2026-07-12T10:00:00.000Z"),
      id,
    });
    assert.deepEqual(decodeSessionListCursor(idle), {
      date: null,
      id,
    });
  });

  it("rejects malformed cursors instead of soft-falling back", () => {
    const invalid = [
      "not-a-cursor",
      `not-a-date|${id}`,
      "2026-07-12T10:00:00.000Z|not-a-uuid",
      "2026-07-12T10:00:00.000Z|",
      `|${id}`,
      "null|",
      "null|abc",
    ];
    for (const cursor of invalid) {
      assert.throws(
        () => decodeSessionListCursor(cursor),
        (error: unknown) => error instanceof InvalidSessionListCursorError,
      );
    }
  });
});

describe("parseSessionSourceKeys", () => {
  it("returns null when the filter is absent", () => {
    assert.equal(parseSessionSourceKeys(null), null);
    assert.equal(parseSessionSourceKeys(undefined), null);
    assert.equal(parseSessionSourceKeys(""), null);
    assert.equal(parseSessionSourceKeys("   "), null);
  });

  it("parses, trims and dedupes comma-separated kinds", () => {
    assert.deepEqual(parseSessionSourceKeys("web"), { keys: ["web"] });
    assert.deepEqual(parseSessionSourceKeys(" WEB , feishu "), {
      keys: ["web", "feishu"],
    });
    assert.deepEqual(parseSessionSourceKeys("web,web"), { keys: ["web"] });
  });

  it("rejects unknown kinds instead of silently returning everything", () => {
    assert.throws(
      () => parseSessionSourceKeys("nope"),
      (error: unknown) =>
        error instanceof InvalidSessionSourceFilterError &&
        error.unknownKeys[0] === "nope",
    );
  });
});

describe("countUserSessionsBySource", () => {
  it("counts raw sources by kind, mapping null to web", () => {
    assert.deepEqual(
      countUserSessionsBySource([
        { source: null },
        { source: "web" },
        { source: "web_app" },
        { source: "scheduled_task" },
        { source: "qq:c2c:1" },
        { source: "mystery" },
      ]),
      [
        { key: "scheduled_task", count: 1 },
        { key: "web", count: 3 },
        { key: "qq", count: 1 },
        { key: "other", count: 1 },
      ],
    );
  });
});
