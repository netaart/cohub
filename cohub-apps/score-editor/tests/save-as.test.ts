import assert from "node:assert/strict";
import { test } from "node:test";
import { saveAsPath, saveGeneratedScore } from "../src/host/save-as.ts";
import { createFakeClient, type FakeClient } from "./fake-client.ts";

const TASK = "task-1";

async function clientWith(files: Record<string, string> = {}): Promise<FakeClient> {
  const client = createFakeClient({ files });
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "test",
  });
  return client;
}

test("a generation without a source file saves into scores/ named from its title", () => {
  assert.equal(
    saveAsPath({ sourceFile: null, taskRunId: TASK, name: "Morning walk" }, new Set()),
    "scores/Morning walk.abc",
  );
  assert.equal(saveAsPath({ sourceFile: null, taskRunId: TASK, name: null }, new Set()), "scores/task-1.abc");
  assert.equal(saveAsPath({ sourceFile: null, taskRunId: TASK, name: "   " }, new Set()), "scores/task-1.abc");
});

test("a save beside a source file adds a suffix to its name", () => {
  assert.equal(
    saveAsPath({ sourceFile: "projects/morning-walk.abc", taskRunId: TASK }, new Set()),
    "projects/morning-walk-copy.abc",
  );
});

test("a source file at the Space root saves beside it", () => {
  assert.equal(
    saveAsPath({ sourceFile: "intro.abc", taskRunId: TASK }, new Set()),
    "intro-copy.abc",
  );
});

test("a taken name gets the next free suffix", () => {
  assert.equal(
    saveAsPath({ sourceFile: null, taskRunId: TASK }, new Set(["task-1.abc"])),
    "scores/task-1-2.abc",
  );
  assert.equal(
    saveAsPath({ sourceFile: null, taskRunId: TASK }, new Set(["task-1.abc", "task-1-2.abc"])),
    "scores/task-1-3.abc",
  );
  assert.equal(
    saveAsPath(
      { sourceFile: "projects/morning-walk.abc", taskRunId: TASK },
      new Set(["morning-walk-copy.abc"]),
    ),
    "projects/morning-walk-copy-2.abc",
  );
});

test("Save as writes a new file in the Space without a version", async () => {
  const client = await clientWith();

  const result = await saveGeneratedScore({
    client,
    spaceId: "space-1",
    sourceFile: null,
    taskRunId: TASK,
    text: "X:1\n",
  });

  assert.deepEqual(result, { ok: true, path: "scores/task-1.abc" });
  assert.deepEqual(client.writes[0], {
    kind: "write",
    spaceId: "space-1",
    path: "scores/task-1.abc",
    text: "X:1\n",
    expected: null,
  });
});

test("Save as beside a source file writes the copy and leaves the source alone", async () => {
  const client = await clientWith({ "projects/morning-walk.abc": "original" });

  const result = await saveGeneratedScore({
    client,
    spaceId: "space-1",
    sourceFile: "projects/morning-walk.abc",
    taskRunId: TASK,
    text: "X:1\n",
  });

  assert.deepEqual(result, { ok: true, path: "projects/morning-walk-copy.abc" });
  assert.equal(client.fileAt("projects/morning-walk.abc")?.text, "original");
  assert.equal(client.fileAt("projects/morning-walk-copy.abc")?.text, "X:1\n");
});

test("Save as never overwrites: a taken name is skipped", async () => {
  const client = await clientWith({ "scores/task-1.abc": "older" });

  const result = await saveGeneratedScore({
    client,
    spaceId: "space-1",
    sourceFile: null,
    taskRunId: TASK,
    text: "X:1\n",
  });

  assert.deepEqual(result, { ok: true, path: "scores/task-1-2.abc" });
  assert.equal(client.fileAt("scores/task-1.abc")?.text, "older");
});

test("Save as answers failed when the folder cannot be listed", async () => {
  const client = await clientWith();
  client.failNextList(new Error("network down"));

  const result = await saveGeneratedScore({
    client,
    spaceId: "space-1",
    sourceFile: "projects/morning-walk.abc",
    taskRunId: TASK,
    text: "X:1\n",
  });

  assert.deepEqual(result, { ok: false, reason: "failed" });
  assert.equal(client.writes.length, 0);
});
