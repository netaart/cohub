import assert from "node:assert/strict";
import test from "node:test";
import type { TaskRunRecord } from "@neta-art/cohub";
import { mergeTaskRefresh, toGenerationTask } from "./task-output.ts";

function generationRun(result: unknown): TaskRunRecord {
  return {
    id: "task-1",
    jobId: "job-1",
    cronJobId: null,
    taskType: "generation",
    status: "completed",
    payload: {
      data: {
        model: "image-model",
        content: [{ type: "text", text: "Four interface studies" }],
      },
    },
    result,
    errorMessage: null,
    attemptCount: 1,
    spaceId: "space-1",
    sessionId: "session-1",
    turnId: "turn-1",
    userUuid: "user-1",
    scheduledAt: null,
    startedAt: "2026-08-19T10:00:00.000Z",
    finishedAt: "2026-08-19T10:00:05.000Z",
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:05.000Z",
  };
}

test("projects every generation output as an independent gallery item", () => {
  const output = Array.from({ length: 20 }, (_, index) => ({
    type: "image",
    url: `https://assets.example/${index}.png`,
  }));
  const task = toGenerationTask(generationRun({ output }));

  assert.equal(task.prompt, "Four interface studies");
  assert.equal(task.outputs.length, 20);
  assert.equal(task.outputCount, 20);
  assert.equal(task.outputs[19]?.index, 19);
});

test("refreshes the first page without dropping loaded history", () => {
  const first = toGenerationTask(generationRun({ output: [] }));
  const history = { ...first, id: "task-history" };
  const refreshed = { ...first, status: "completed" as const };

  assert.deepEqual(
    mergeTaskRefresh([first, history], [refreshed]).map(({ id, status }) => ({ id, status })),
    [
      { id: "task-1", status: "completed" },
      { id: "task-history", status: "completed" },
    ],
  );
});

test("keeps deferred outputs addressable without retaining inline media URLs", () => {
  const task = toGenerationTask(
    generationRun({
      output: [
        { type: "image", deferredBase64: true },
        { type: "video", src: "data:video/mp4;base64,inline" },
      ],
    }),
  );

  assert.deepEqual(
    task.outputs.map(({ index, url, deferred }) => ({ index, url, deferred })),
    [
      { index: 0, url: null, deferred: true },
      { index: 1, url: null, deferred: true },
    ],
  );
});
