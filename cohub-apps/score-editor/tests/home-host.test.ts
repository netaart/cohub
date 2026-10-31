import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeHome, copyScoreToSpace, createNewScore, listHomeSongs, pickWorkingSpace, walkScoreFiles } from "../src/host/home.ts";
import { NEW_SCORE_TEXT } from "../src/app/home.ts";
import type { TaskRunSnapshot } from "../src/host/task.ts";
import { createFakeClient } from "./fake-client.ts";

test("home authorization asks full, then read, then file.view alone", async () => {
  const watched = createFakeClient({ scopes: ["file.view", "taskrun.view"] });
  const read = await authorizeHome({
    client: watched,
    spaceId: "space-1",
    reason: "Browse and edit scores in this Space.",
  });
  assert.equal(read.status, "granted");
  assert.deepEqual(
    watched.calls.filter((call) => call.kind === "authorize").map((call) => (call as { scopes: readonly string[] }).scopes),
    [
      ["file.view", "taskrun.view", "file.edit"],
      ["file.view", "taskrun.view"],
    ],
  );

  const viewOnly = createFakeClient({ scopes: ["file.view"] });
  const view = await authorizeHome({
    client: viewOnly,
    spaceId: "space-1",
    reason: "Browse and edit scores in this Space.",
  });
  assert.equal(view.status, "granted");
  assert.deepEqual(view.scopes, ["file.view"]);
  assert.deepEqual(
    viewOnly.calls.filter((call) => call.kind === "authorize").map((call) => (call as { scopes: readonly string[] }).scopes),
    [
      ["file.view", "taskrun.view", "file.edit"],
      ["file.view", "taskrun.view"],
      ["file.view"],
    ],
  );

  const cancelled = createFakeClient({ authorize: "cancelled" });
  const answer = await authorizeHome({
    client: cancelled,
    spaceId: "space-1",
    reason: "Browse and edit scores in this Space.",
  });
  assert.equal(answer.status, "cancelled");
  assert.equal(cancelled.calls.filter((call) => call.kind === "authorize").length, 1);
});

const SONG = `X:1
T:
M:4/4
L:1/16
Q:1/4=100
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
K:C
% verse
V: Vocal
C16|D16|
`;

function task(id: string, createdAt: string, score = SONG): TaskRunSnapshot {
  return {
    id,
    spaceId: "space-1",
    status: "completed",
    createdAt,
    payload: { data: { model: "song2", content: [], parameters: {} } },
    result: { output: [{ type: "text", text: score, meta: { role: "abc" } }] },
  };
}

test("a song page filters non-songs and follows the cursor", async () => {
  const client = createFakeClient({
    tasks: {
      a: task("a", "2026-10-28T10:00:00.000Z"),
      b: { ...task("b", "2026-10-27T10:00:00.000Z"), result: { output: [{ type: "image" }] } },
      c: task("c", "2026-10-26T10:00:00.000Z"),
      d: task("d", "2026-10-25T10:00:00.000Z"),
      e: task("e", "2026-10-24T10:00:00.000Z"),
      f: task("f", "2026-10-23T10:00:00.000Z"),
    },
  });
  await client.authorize({ spaceId: "space-1", scopes: ["taskrun.view"], reason: "test" });

  const first = await listHomeSongs({ client, spaceId: "space-1", limit: 2 });
  assert.deepEqual(first.rows.map((row) => row.id), ["a", "c", "d"]);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, "4");

  const second = await listHomeSongs({ client, spaceId: "space-1", limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.rows.map((row) => row.id), ["e", "f"]);
  assert.equal(second.hasMore, false);
});

test("the walk finds .abc files in nested folders and skips internal ones", async () => {
  const client = createFakeClient({
    files: {
      "scores/intro.abc": SONG,
      "world/song.abc": SONG,
      "nested/deep.abc": SONG,
      "notes/readme.txt": "not a score",
      ".cohub/score-drafts/task.abc": SONG,
      ".git/objects/thing.abc": SONG,
    },
  });
  await client.authorize({ spaceId: "space-1", scopes: ["file.view"], reason: "test" });

  const found: string[] = [];
  for await (const batch of walkScoreFiles({ client, spaceId: "space-1" })) {
    found.push(...batch.map((item) => item.entry.path));
  }
  assert.deepEqual(found.sort(), ["nested/deep.abc", "scores/intro.abc", "world/song.abc"]);
});

test("the walk skips installed packages' sample scores", async () => {
  const client = createFakeClient({
    files: {
      "scores/intro.abc": SONG,
      "node_modules/@neta-art/score-editor/skills/score-editor/assets/edit-one-bar/score.abc": SONG,
    },
  });
  await client.authorize({ spaceId: "space-1", scopes: ["file.view"], reason: "test" });

  const found: string[] = [];
  for await (const batch of walkScoreFiles({ client, spaceId: "space-1" })) {
    found.push(...batch.map((item) => item.entry.path));
  }
  assert.deepEqual(found, ["scores/intro.abc"]);
});

test("a copy into another Space uses Save as names and never overwrites", async () => {
  const client = createFakeClient({
    files: {
      "world/theme.abc": "old source",
      "world/theme-copy.abc": "already here",
    },
  });
  await client.authorize({ spaceId: "space-2", scopes: ["file.view", "file.edit"], reason: "test" });

  const result = await copyScoreToSpace({
    client,
    spaceId: "space-2",
    sourceFile: "world/theme.abc",
    taskRunId: "task-1",
    name: null,
    text: "copied score",
  });
  assert.deepEqual(result, { ok: true, path: "world/theme-copy-2.abc" });
  assert.equal(client.fileAt("world/theme-copy.abc")?.text, "already here");
  assert.equal(client.fileAt("world/theme-copy-2.abc")?.text, "copied score");

  const songCopy = await copyScoreToSpace({
    client,
    spaceId: "space-2",
    sourceFile: null,
    taskRunId: "task-1",
    name: "Morning light",
    text: "song score",
  });
  assert.deepEqual(songCopy, { ok: true, path: "scores/Morning light.abc" });
});

test("a new score writes the smallest song2 score without overwriting", async () => {
  const client = createFakeClient({ files: { "scores/new-score.abc": "old" } });
  await client.authorize({ spaceId: "space-1", scopes: ["file.view", "file.edit"], reason: "test" });

  const result = await createNewScore({ client, spaceId: "space-1", text: NEW_SCORE_TEXT });
  assert.deepEqual(result, { ok: true, path: "scores/new-score-2.abc" });
  assert.equal(client.fileAt("scores/new-score.abc")?.text, "old");
  assert.equal(client.fileAt("scores/new-score-2.abc")?.text, NEW_SCORE_TEXT);
});

test("picking a working Space asks with the full set and answers its name", async () => {
  const client = createFakeClient({ pickedSpace: { id: "space-9", name: "Mine" } });
  const result = await pickWorkingSpace({ client, reason: "Work in a Space of yours." });
  assert.deepEqual(result, { status: "granted", space: { id: "space-9", name: "Mine" }, scopes: ["file.view", "taskrun.view", "file.edit"] });
  const call = client.calls.find((entry) => entry.kind === "pick-space");
  assert.deepEqual(call, {
    kind: "pick-space",
    scopes: ["file.view", "taskrun.view", "file.edit"],
    reason: "Work in a Space of yours.",
  });
});

test("picking a working Space can be declined without a write", async () => {
  const client = createFakeClient({ pickSpaceAnswer: "denied" });
  const result = await pickWorkingSpace({ client, reason: "Work in a Space of yours." });
  assert.deepEqual(result, { status: "denied", code: "cancelled" });
  assert.equal(client.writes.length, 0);
});

test("a working Space lists its own songs and files, not the context Space's", async () => {
  const client = createFakeClient({
    tasks: {
      mine: { ...task("mine", "2026-10-28T10:00:00.000Z"), spaceId: "space-9" },
      theirs: task("theirs", "2026-10-28T11:00:00.000Z"),
    },
    files: { "scores/mine.abc": SONG, "scores/theirs.abc": SONG },
  });
  await client.authorize({
    spaceId: "space-9",
    scopes: ["file.view", "taskrun.view", "file.edit"],
    reason: "test",
  });

  const page = await listHomeSongs({ client, spaceId: "space-9", limit: 20 });
  assert.deepEqual(page.rows.map((row) => row.id), ["mine"]);
});

test("a new score is written in the working Space, not the context Space", async () => {
  const client = createFakeClient();
  await client.authorize({ spaceId: "space-9", scopes: ["file.view", "file.edit"], reason: "test" });
  const result = await createNewScore({ client, spaceId: "space-9", text: NEW_SCORE_TEXT });
  assert.deepEqual(result, { ok: true, path: "scores/new-score.abc" });
  assert.equal(client.writes[0]?.spaceId, "space-9");
  assert.equal(client.fileAt("scores/new-score.abc")?.text, NEW_SCORE_TEXT);
});

test("a song page that overflows keeps every song in order", async () => {
  const all = Array.from({ length: 30 }, (_, index) =>
    task(
      `task-${String(index).padStart(2, "0")}`,
      new Date(Date.UTC(2026, 9, 28, 23) - index * 3_600_000).toISOString(),
    ),
  );
  const pages: Array<{ runs: TaskRunSnapshot[]; hasMore: boolean; nextCursor: string | null }> = [
    { runs: all.slice(0, 12), hasMore: true, nextCursor: "page-2" },
    { runs: all.slice(12), hasMore: false, nextCursor: null },
  ];
  const client = {
    async listTasks({ cursor }: { cursor?: string | null }) {
      const page = pages[cursor === "page-2" ? 1 : 0];
      if (!page) throw new Error("no page");
      return page;
    },
  };
  const page = await listHomeSongs({ client, spaceId: "space-1", limit: 20 });
  assert.equal(page.rows.length, 30);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.rows.map((row) => row.id), all.map((run) => run.id));
});

test("a fallback grant's Space takes the copy and the new score", async () => {
  const client = createFakeClient({
    files: { "world/theme.abc": "old source" },
    fallbackSpace: { id: "space-9", name: "Visitor World" },
  });
  const access = await authorizeHome({
    client,
    spaceId: "space-1",
    reason: "Browse and edit scores in this Space.",
    fallback: "allow",
  });
  assert.equal(access.status, "granted");
  if (access.status !== "granted") throw new Error("no grant");
  assert.deepEqual(access.space, { id: "space-9", name: "Visitor World" });

  const copy = await copyScoreToSpace({
    client,
    spaceId: access.space.id,
    sourceFile: "world/theme.abc",
    taskRunId: "task-1",
    name: null,
    text: "copied score",
  });
  assert.equal(copy.ok, true);
  const created = await createNewScore({ client, spaceId: access.space.id, text: NEW_SCORE_TEXT });
  assert.equal(created.ok, true);
  assert.ok(client.writes.length >= 2);
  assert.ok(client.writes.every((write) => write.spaceId === "space-9"));
  assert.equal(client.writes.some((write) => write.spaceId === "space-1"), false);
});
