import assert from "node:assert/strict";
import { test } from "node:test";
import { createDraftStore, draftPath } from "../src/host/drafts.ts";
import { versionString } from "../src/host/host.ts";
import { createFakeClient, FakeRequestError } from "./fake-client.ts";

const DIR = ".cohub/score-drafts";

async function storeFor(client: ReturnType<typeof createFakeClient>) {
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "test",
  });
  return createDraftStore({ client, spaceId: "space-1" });
}

test("a draft is read at .cohub/score-drafts/<key>.json with its version", async () => {
  const client = createFakeClient({ files: { [draftPath("task-1")]: '{"version":1}' } });
  const store = await storeFor(client);
  const file = client.fileAt(draftPath("task-1"));
  assert.ok(file);

  const entry = await store.read("task-1");

  assert.deepEqual(entry, { text: '{"version":1}', version: versionString(file.version) });
  assert.deepEqual(client.calls.at(-1), {
    kind: "read",
    spaceId: "space-1",
    path: `${DIR}/task-1.json`,
  });
});

test("a draft that is not there reads as none", async () => {
  const client = createFakeClient();
  const store = await storeFor(client);

  assert.equal(await store.read("task-1"), null);
});

test("creating a draft writes the path with no version", async () => {
  const client = createFakeClient();
  const store = await storeFor(client);

  const result = await store.write("task-1", "draft text", null);

  assert.equal(result.ok, true);
  assert.deepEqual(client.writes[0], {
    kind: "write",
    spaceId: "space-1",
    path: `${DIR}/task-1.json`,
    text: "draft text",
    expected: null,
  });
  const file = client.fileAt(draftPath("task-1"));
  assert.ok(file);
  assert.deepEqual(result, { ok: true, version: versionString(file.version) });
});

test("creating a draft that another window already created answers conflict", async () => {
  const client = createFakeClient({ files: { [draftPath("task-1")]: "theirs" } });
  const store = await storeFor(client);

  const result = await store.write("task-1", "ours", null);

  assert.deepEqual(result, { ok: false, reason: "conflict" });
  assert.equal(client.writes.length, 0);
  assert.equal(client.fileAt(draftPath("task-1"))?.text, "theirs");
});

test("updating a draft writes at the version last read and answers the new version", async () => {
  const client = createFakeClient({ files: { [draftPath("task-1")]: "old" } });
  const store = await storeFor(client);
  const before = client.fileAt(draftPath("task-1"));
  assert.ok(before);

  const result = await store.write("task-1", "new", versionString(before.version));

  assert.equal(result.ok, true);
  assert.deepEqual(client.writes[0]?.expected, before.version);
  const after = client.fileAt(draftPath("task-1"));
  assert.ok(after);
  assert.deepEqual(result, { ok: true, version: versionString(after.version) });
});

test("a draft changed by another window answers conflict and does not overwrite", async () => {
  const client = createFakeClient({ files: { [draftPath("task-1")]: "ours" } });
  const store = await storeFor(client);
  const stale = client.fileAt(draftPath("task-1"));
  assert.ok(stale);
  client.setFile(draftPath("task-1"), "theirs");

  const result = await store.write("task-1", "ours, again", versionString(stale.version));

  assert.deepEqual(result, { ok: false, reason: "conflict" });
  assert.equal(client.fileAt(draftPath("task-1"))?.text, "theirs");
});

test("a write that fails for another reason says failed", async () => {
  const client = createFakeClient();
  const store = await storeFor(client);
  client.failNextWrite(new Error("network down"));

  assert.deepEqual(await store.write("task-1", "text", null), { ok: false, reason: "failed" });
});

test("a draft write refused for access says no-access", async () => {
  const client = createFakeClient();
  const store = await storeFor(client);
  client.failNextWrite(new FakeRequestError(403));

  assert.deepEqual(await store.write("task-1", "text", null), { ok: false, reason: "no-access" });
});

test("list returns the draft keys in the folder and nothing else", async () => {
  const client = createFakeClient({
    files: {
      [`${DIR}/task-1.json`]: "a",
      [`${DIR}/task-2.json`]: "b",
      [`${DIR}/notes.txt`]: "not a draft",
      "scores/intro.abc": "score",
    },
  });
  const store = await storeFor(client);

  assert.deepEqual(await store.list(), ["task-1", "task-2"]);
  assert.deepEqual(client.calls.at(-1), {
    kind: "list",
    spaceId: "space-1",
    path: DIR,
  });
});

test("list is empty when the draft folder does not exist", async () => {
  const client = createFakeClient();
  const store = await storeFor(client);

  assert.deepEqual(await store.list(), []);
});

test("removing a draft at its version deletes the file", async () => {
  const client = createFakeClient({ files: { [draftPath("task-1")]: "draft" } });
  const store = await storeFor(client);
  const file = client.fileAt(draftPath("task-1"));
  assert.ok(file);

  const result = await store.remove("task-1", versionString(file.version));

  assert.equal(result.ok, true);
  assert.equal(client.fileAt(draftPath("task-1")), null);
});

test("removing a draft another window changed answers conflict and keeps it", async () => {
  const client = createFakeClient({ files: { [draftPath("task-1")]: "ours" } });
  const store = await storeFor(client);
  const stale = client.fileAt(draftPath("task-1"));
  assert.ok(stale);
  client.setFile(draftPath("task-1"), "theirs");

  const result = await store.remove("task-1", versionString(stale.version));

  assert.deepEqual(result, { ok: false, reason: "conflict" });
  assert.equal(client.fileAt(draftPath("task-1"))?.text, "theirs");
});

test("removing a draft that is already gone succeeds", async () => {
  const client = createFakeClient();
  const store = await storeFor(client);

  assert.deepEqual(await store.remove("task-1", "1:2"), { ok: true, version: "1:2" });
});
