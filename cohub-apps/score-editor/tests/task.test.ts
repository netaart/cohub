import assert from "node:assert/strict";
import { test } from "node:test";
import { projectFromTask, type TaskRunSnapshot } from "../src/host/task.ts";

const INPUT_SCORE = `X:1
T:
M:4/4
L:1/16
Q:1/4=190
K:E
% intro
z12e2e2|b6b4e4f2-|
`;

const OUTPUT_SCORE = INPUT_SCORE.replace("z12e2e2", "z12f2e2");

function task(overrides: Partial<TaskRunSnapshot> = {}): TaskRunSnapshot {
  return {
    id: "task-1",
    spaceId: "space-1",
    payload: {
      type: "generation",
      data: {
        model: "song2",
        content: [
          { type: "text", text: "warm synthwave", meta: { role: "prompt" } },
          { type: "text", text: "[Verse]\nNeon lights", meta: { role: "lyrics" } },
          { type: "text", text: INPUT_SCORE, meta: { role: "abc" } },
        ],
        parameters: { seed: 42, return_abc: true },
      },
    },
    result: {
      output: [
        { type: "audio", source: { url: "https://cdn.example.test/song.mp3" } },
        { type: "text", text: OUTPUT_SCORE, meta: { role: "abc" } },
      ],
    },
    ...overrides,
  };
}

test("a generation builds the project from the prompt, lyrics, output score, seed and model", () => {
  const project = projectFromTask(task());

  assert.deepEqual(project, {
    style: "warm synthwave",
    lyrics: "[Verse]\nNeon lights",
    score: OUTPUT_SCORE,
    scoreMode: "full",
    seed: 42,
    modelId: "song2",
    sourceKey: "task-1",
  });
});

test("an input score is the score when the output has none", () => {
  const project = projectFromTask(task({ result: { output: [{ type: "audio" }] } }));
  assert.equal(project.score, INPUT_SCORE);
});

test("a generation without lyrics leaves the lyrics empty", () => {
  const run = task();
  const data = (run.payload as { data: { content: unknown[] } }).data;
  data.content = data.content.filter(
    (block) => (block as { meta?: { role?: string } }).meta?.role !== "lyrics",
  );

  const project = projectFromTask(run);

  assert.equal(project.lyrics, "");
  assert.equal(project.style, "warm synthwave");
});

test("absent parameters leave the seed null and the score mode full", () => {
  const run = task();
  delete (run.payload as { data: { parameters?: unknown } }).data.parameters;

  const project = projectFromTask(run);

  assert.equal(project.seed, null);
  assert.equal(project.scoreMode, "full");
});

test("the score mode comes from the abc_mode parameter", () => {
  const run = task();
  (run.payload as { data: { parameters: Record<string, unknown> } }).data.parameters.abc_mode =
    "melody";

  assert.equal(projectFromTask(run).scoreMode, "melody");
});

test("a generation with no score at all opens with an empty score", () => {
  const run = task({ result: { output: [] } });
  (run.payload as { data: { content: unknown[] } }).data.content = [];

  assert.equal(projectFromTask(run).score, "");
});

test("text that is not a role is not taken for style, lyrics or score", () => {
  const run = task({
    payload: {
      data: {
        model: "song2",
        content: [{ type: "text", text: "a positional prompt" }],
      },
    },
    result: {},
  });

  const project = projectFromTask(run);

  assert.equal(project.style, "");
  assert.equal(project.lyrics, "");
  assert.equal(project.score, "");
});

test("a task payload without the nested data field still reads", () => {
  const project = projectFromTask({
    id: "task-2",
    spaceId: "space-2",
    payload: {
      model: "song2",
      content: [
        { type: "text", text: "folk", meta: { role: "prompt" } },
        { type: "text", text: "line", meta: { role: "lyrics" } },
        { type: "text", text: INPUT_SCORE, meta: { role: "abc" } },
      ],
      parameters: { seed: 7 },
    },
    result: {},
  });

  assert.equal(project.style, "folk");
  assert.equal(project.lyrics, "line");
  assert.equal(project.score, INPUT_SCORE);
  assert.equal(project.seed, 7);
  assert.equal(project.sourceKey, "task-2");
});
