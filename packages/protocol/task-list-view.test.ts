import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTaskRunForList } from "./src/task/list-view.js";

const url = { type: "url", url: "https://cdn.example.com/a.png" };

test("strips inline generation inputs and outputs for list views", () => {
  const run = {
    taskType: "generation",
    payload: {
      type: "generation",
      data: {
        model: "m",
        content: [
          { type: "text", text: "prompt" },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" }, meta: { role: "first_frame" } },
          { type: "image", source: url },
        ],
      },
    },
    result: { output: [{ type: "video", source: { type: "base64", mediaType: "video/mp4", data: "BBBB" } }] },
  };
  const listed = sanitizeTaskRunForList(run);

  assert.deepEqual(listed.payload.data.content, [
    { type: "text", text: "prompt" },
    { type: "image", source: { type: "base64", mediaType: "image/png", deferredBase64: true }, meta: { role: "first_frame" } },
    { type: "image", source: url },
  ]);
  assert.deepEqual(listed.result.output, [
    { type: "video", source: { type: "base64", mediaType: "video/mp4", deferredBase64: true } },
  ]);
  assert.equal(listed.payload.data.content[2], run.payload.data.content[2]);
  assert.equal(run.payload.data.content[1]?.source?.data, "AAAA", "input is not mutated");
});

test("returns the same run when nothing is inline or the task is not a generation", () => {
  const remote = {
    taskType: "generation",
    payload: { data: { content: [{ type: "image", source: url }] } },
    result: { output: [{ type: "image", source: url }] },
  };
  assert.equal(sanitizeTaskRunForList(remote), remote);

  const command = { taskType: "run_command", payload: { data: { content: [{ type: "image", data: "AAAA" }] } }, result: null };
  assert.equal(sanitizeTaskRunForList(command), command);
});
