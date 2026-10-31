import assert from "node:assert/strict";
import { test } from "node:test";
import { copySongId, formatHomeTime, homeFileRow, homeSongRows, newScorePath, NEW_SCORE_TEXT, sortHomeSongs, timeIso } from "../src/app/home.ts";
import { song2Dialect } from "@neta-art/score-dialect-song2";
import type { TaskRunSnapshot } from "../src/host/task.ts";

const SCORE = `X:1
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

function run(overrides: Partial<TaskRunSnapshot> = {}): TaskRunSnapshot {
  return {
    id: "task-1",
    spaceId: "space-1",
    status: "completed",
    createdAt: "2026-10-28T09:30:00.000Z",
    payload: {
      data: {
        model: "song2",
        content: [
          { type: "text", text: "warm synthwave", meta: { role: "prompt" } },
          { type: "text", text: "[Verse]\nNeon lights", meta: { role: "lyrics" } },
        ],
        parameters: { seed: 42 },
      },
    },
    result: { output: [{ type: "text", text: SCORE, meta: { role: "abc" } }] },
    ...overrides,
  };
}

test("a completed generation with a score is one song row", () => {
  const rows = homeSongRows([run()]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, "task-1");
  assert.equal(rows[0]?.title, "Neon lights");
  assert.equal(rows[0]?.style, "warm synthwave");
  assert.equal(rows[0]?.createdAt, "2026-10-28T09:30:00.000Z");
});

test("an image generation without a score is not a song", () => {
  const image = run({
    result: { output: [{ type: "image", source: { url: "https://example.test/a.png" } }] },
  });
  assert.deepEqual(homeSongRows([image]), []);
});

test("the request score makes a song when the output has no score", () => {
  const request = run({
    payload: {
      data: {
        model: "song2",
        content: [{ type: "text", text: SCORE, meta: { role: "abc" } }],
        parameters: {},
      },
    },
    result: { output: [] },
  });
  const rows = homeSongRows([request]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.score, SCORE);
});

test("a blank output score falls back to the request score", () => {
  const blank = run({
    payload: {
      data: {
        model: "song2",
        content: [
          { type: "text", text: SCORE, meta: { role: "abc" } },
          { type: "text", text: "warm synthwave", meta: { role: "prompt" } },
        ],
        parameters: {},
      },
    },
    result: { output: [{ type: "text", text: " \n", meta: { role: "abc" } }] },
  });
  const rows = homeSongRows([blank]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.score, SCORE);
});

test("a new score path is scores/new-score.abc and never overwrites", () => {
  assert.equal(newScorePath(new Set()), "scores/new-score.abc");
  assert.equal(newScorePath(new Set(["new-score.abc"])), "scores/new-score-2.abc");
  assert.equal(
    newScorePath(new Set(["new-score.abc", "new-score-2.abc"])),
    "scores/new-score-3.abc",
  );
});

test("a file is a copy of a song when it equals the output or the request score", () => {
  const [output] = homeSongRows([run()]);
  assert.ok(output);
  const request = homeSongRows([
    run({
      id: "task-2",
      createdAt: "2026-10-27T09:30:00.000Z",
      payload: {
        data: {
          model: "song2",
          content: [{ type: "text", text: SCORE, meta: { role: "abc" } }],
          parameters: {},
        },
      },
      result: { output: [] },
    }),
  ]);
  const [requestRow] = request;
  assert.ok(requestRow);

  assert.equal(copySongId(SCORE, [output]), "task-1");
  assert.equal(copySongId(`${SCORE}\n\n`, [output]), "task-1");
  assert.equal(copySongId(` ${SCORE}`, [output]), null);
  assert.equal(copySongId(SCORE, [output, requestRow]), "task-1");
});

test("the request score also identifies a generated copy", () => {
  const input = SCORE.replace("D16", "E16");
  const rows = homeSongRows([
    run({
      payload: {
        data: {
          model: "song2",
          content: [
            { type: "text", text: input, meta: { role: "abc" } },
            { type: "text", text: "[Verse]\nNeon lights", meta: { role: "lyrics" } },
          ],
          parameters: {},
        },
      },
    }),
  ]);
  const [song] = rows;
  assert.ok(song);
  assert.notEqual(song.score, input);
  assert.equal(copySongId(input, [song]), "task-1");
});

test("a home time is the time today, the date this year, and the full date before that", () => {
  const now = Date.UTC(2026, 9, 28, 18, 0, 0);
  assert.equal(formatHomeTime("2026-10-28T09:30:00.000Z", "en", { now, timeZone: "UTC" }), "09:30 AM");
  assert.equal(formatHomeTime("2026-03-02T09:30:00.000Z", "en", { now, timeZone: "UTC" }), "Mar 2");
  assert.equal(formatHomeTime("2024-03-02T09:30:00.000Z", "en", { now, timeZone: "UTC" }), "Mar 2, 2024");
});

test("the smallest new score is valid song2", () => {
  const read = song2Dialect.parse(NEW_SCORE_TEXT);
  assert.equal(read.diagnostics.length, 0);
  assert.ok(read.score);
  assert.deepEqual(song2Dialect.check(read.score), []);
});

test("a score file row carries its folder, time and the song it copies", () => {
  const [song] = homeSongRows([run()]);
  assert.ok(song);
  const row = homeFileRow(
    { name: "intro.abc", path: "scores/intro.abc", type: "file", mtimeMs: 1_790_000_000_000, size: 42 },
    `${SCORE}\n`,
    [song],
  );
  assert.equal(row.name, "intro.abc");
  assert.equal(row.folder, "scores");
  assert.equal(row.mtimeMs, 1_790_000_000_000);
  assert.equal(row.size, 42);
  assert.equal(row.copyTaskId, "task-1");
  assert.equal(homeFileRow({ name: "song.abc", path: "song.abc", type: "file", mtimeMs: 1, size: 1 }, SCORE, []).folder, "");
});

test("an empty or unreadable file never matches a song", () => {
  const [song] = homeSongRows([run()]);
  assert.ok(song);
  const blankSong = { ...song, requestScore: "", outputScore: "" };
  assert.equal(copySongId("", [song]), null);
  assert.equal(copySongId("   \n", [song]), null);
  assert.equal(copySongId("", [blankSong]), null);
  assert.equal(homeFileRow({ name: "empty.abc", path: "empty.abc", mtimeMs: 1, size: 0 }, "", [song]).copyTaskId, null);
  assert.equal(homeFileRow({ name: "empty.abc", path: "empty.abc", mtimeMs: 1, size: 0 }, null, [song]).copyTaskId, null);
});

test("a missing or epoch-zero time is no time and has no machine datetime", () => {
  assert.equal(formatHomeTime(0, "en"), "");
  assert.equal(formatHomeTime(null, "en"), "");
  assert.equal(formatHomeTime("", "en"), "");
  assert.equal(timeIso(0), "");
  assert.equal(timeIso(null), "");
  assert.equal(timeIso(1_790_000_000_000), "2026-09-21T14:13:20.000Z");
});

test("a song's style is not repeated when it was the title", () => {
  const runnable = run({
    payload: {
      data: {
        model: "song2",
        content: [{ type: "text", text: "city pop", meta: { role: "prompt" } }],
        parameters: {},
      },
    },
  });
  const [song] = homeSongRows([runnable]);
  assert.ok(song);
  assert.equal(song.title, "city pop");
  assert.equal(song.style, "");
});

test("a song without a time sorts after dated songs", () => {
  const rows = homeSongRows([
    run({ id: "task-undated", createdAt: "" }),
    run({ id: "task-older", createdAt: "2026-10-27T09:30:00.000Z" }),
    run({ id: "task-newer", createdAt: "2026-10-28T09:30:00.000Z" }),
  ]);
  assert.deepEqual(sortHomeSongs(rows).map((song) => song.id), [
    "task-newer",
    "task-older",
    "task-undated",
  ]);
});
