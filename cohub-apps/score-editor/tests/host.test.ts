import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDialectRegistry,
  createEditingSession,
  createScoreFileKeeper,
  type EditingSession,
  type ScoreFileKeeper,
} from "@neta-art/score-editor";
import { song2Dialect } from "@neta-art/score-dialect-song2";
import { failurePresentation } from "../src/app/policy.ts";
import { createScoreHost, type OpenResult } from "../src/host/host.ts";
import { createFakeClient, FakeRequestError, type FakeCall, type FakeClient } from "./fake-client.ts";

const SAMPLE = `X:1
T:
M:4/4
L:1/16
Q:1/4=190
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:E
% intro
V: Vocal
z12e2e2|b6b4e4f2-|f4g4z4e4|b6b4e2-e2f2-|
V: Ins
Z4|
`;
const EDITED = SAMPLE.replace("z12e2e2", "z12f2e2");
const PATH = "scores/intro.abc";

function editorFor(opened: OpenResult): {
  session: EditingSession;
  keeper: ScoreFileKeeper;
} {
  assert.ok(opened.ok);
  assert.equal(opened.kind, "scoreFile");
  assert.ok(opened.source);
  const session = createEditingSession({
    project: opened.project,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const keeper = createScoreFileKeeper({
    session,
    original: opened.project,
    source: opened.source,
  });
  return { session, keeper };
}

async function openIntro(client: FakeClient) {
  const host = createScoreHost({ client, language: "en" });
  const opened = await host.openFile({ spaceId: "space-1", path: PATH });
  return { host, opened };
}

test("a viewer with only file.view opens read-only after asking for the read scope alone", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE }, scopes: ["file.view"] });
  const { opened } = await openIntro(client);

  assert.ok(opened.ok);
  assert.equal(opened.kind, "scoreFile");
  assert.equal(opened.editable, false);
  assert.deepEqual(
    client.calls
      .filter((call): call is Extract<FakeCall, { kind: "authorize" }> => call.kind === "authorize")
      .map((call) => call.scopes),
    [
      ["file.view", "file.edit"],
      ["file.view"],
    ],
  );
  assert.equal(client.reads(), 1);
});

test("opens the invoked file as a score-file document", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { opened } = await openIntro(client);

  assert.ok(opened.ok);
  assert.equal(opened.kind, "scoreFile");
  assert.ok(opened.source);
  assert.deepEqual(client.calls[0], {
    kind: "authorize",
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
    fallback: "none",
  });
  assert.deepEqual(client.calls[1], { kind: "read", spaceId: "space-1", path: PATH });
  assert.equal(opened.project.score, SAMPLE);
  assert.equal(opened.project.modelId, "song2");
  assert.equal(opened.project.style, "");
  assert.equal(opened.project.seed, null);
  assert.equal(opened.editable, true);
  assert.equal(opened.source.kind, "scoreFile");
  assert.equal(opened.source.name, "intro.abc");
  const file = client.fileAt(PATH);
  assert.ok(file);
  assert.equal(opened.source.version, `${file.version.mtimeMs}:${file.version.size}`);
});

test("a save writes the edited text to the invoked path with the opened version", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  const before = client.fileAt(PATH);
  assert.ok(before);

  const taken = session.dispatch({ type: "replaceScoreText", text: EDITED });
  assert.equal(taken.ok, true);
  const result = await keeper.save();

  assert.equal(result.ok, true);
  assert.deepEqual(client.writes, [
    { kind: "write", spaceId: "space-1", path: PATH, text: EDITED, expected: before.version },
  ]);
  const after = client.fileAt(PATH);
  assert.ok(after);
  assert.equal(after.text, EDITED);
  assert.equal(keeper.version, `${after.version.mtimeMs}:${after.version.size}`);
});

test("the next save carries the version the first save returned", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  await keeper.save();
  const first = client.fileAt(PATH);
  assert.ok(first);

  const again = EDITED.replace("z12f2e2", "z12g2e2");
  session.dispatch({ type: "replaceScoreText", text: again });
  const result = await keeper.save();

  assert.equal(result.ok, true);
  assert.equal(client.writes.length, 2);
  assert.deepEqual(client.writes[1]?.expected, first.version);
});

const THEIRS = SAMPLE.replace("z12e2e2", "z12d2e2");

test("a 409 file_conflict leaves the file alone and opens the two ways out", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.failNextWrite(new FakeRequestError(409, "file_conflict"));

  const result = await keeper.save();

  assert.deepEqual(result, { ok: false, reason: "conflict" });
  assert.equal(keeper.status, "conflict");
  assert.equal(client.writes.length, 1);
  assert.equal(client.fileAt(PATH)?.text, SAMPLE);
});

test("Overwrite reads their version and writes ours with it", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.setFile(PATH, THEIRS);
  const theirs = client.fileAt(PATH);
  assert.ok(theirs);
  client.failNextWrite(new FakeRequestError(409, "file_conflict"));
  await keeper.save();

  await keeper.overwrite();

  assert.equal(client.writes.length, 2);
  assert.deepEqual(client.writes[1], {
    kind: "write",
    spaceId: "space-1",
    path: PATH,
    text: EDITED,
    expected: theirs.version,
  });
  assert.equal(client.fileAt(PATH)?.text, EDITED);
  assert.equal(keeper.status, "clean");
});

test("Load the other version opens their text and version without writing", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.setFile(PATH, THEIRS);
  const theirs = client.fileAt(PATH);
  assert.ok(theirs);
  client.failNextWrite(new FakeRequestError(409, "file_conflict"));
  await keeper.save();

  await keeper.loadTheirs();

  assert.equal(session.project.score, THEIRS);
  assert.equal(keeper.version, `${theirs.version.mtimeMs}:${theirs.version.size}`);
  assert.equal(client.writes.length, 1);
  assert.equal(keeper.status, "clean");
});

test("a revoked grant fails the save once, with no retry, and reports no access", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  const seen: string[] = [];
  host.subscribe((state) => seen.push(state.status));
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.revoke();

  const result = await keeper.save();

  assert.deepEqual(result, { ok: false, reason: "no-access" });
  assert.equal(keeper.accessLost, true);
  assert.equal(client.writes.length, 1);
  assert.deepEqual(host.state(), { status: "no-permission", reason: "revoked" });
  assert.deepEqual(seen, ["no-permission"]);
  const state = host.state();
  assert.equal(state.status, "no-permission");
  if (state.status !== "no-permission") return;
  const shown = failurePresentation(state, { unsaved: true, name: "intro.abc", language: "en" });
  assert.deepEqual(shown, {
    title: "Access to intro.abc was removed",
    body: "Access to intro.abc was removed. Your changes are still here. Ask for access, then save again.",
    keepEditor: true,
    action: "access",
  });
});

test("source.read says why it has no entry: missing for 404 and failed for another error", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  assert.ok(opened.ok);
  assert.equal(opened.kind, "scoreFile");
  assert.ok(opened.source);

  client.deleteFile(PATH);
  assert.deepEqual(await opened.source.read(), { ok: false, reason: "missing" });
  assert.deepEqual(host.state(), { status: "file-gone" });

  client.setFile(PATH, SAMPLE);
  client.failNextRead(new FakeRequestError(500));
  assert.deepEqual(await opened.source.read(), { ok: false, reason: "failed" });
});

test("a cancelled grant opens no file", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE }, authorize: "cancelled" });
  const { opened } = await openIntro(client);
  assert.equal(opened.ok, false);
  assert.deepEqual(opened.state, { status: "no-permission", reason: "missing" });
  assert.equal(client.reads(), 0);
});

test("a missing file reports that it is gone", async () => {
  const client = createFakeClient();
  const { opened } = await openIntro(client);
  assert.equal(opened.ok, false);
  assert.deepEqual(opened.state, { status: "file-gone" });
});

test("a failed read reports a failure, not a permission problem", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  client.failNextRead(new FakeRequestError(500));
  const { opened } = await openIntro(client);
  assert.equal(opened.ok, false);
  assert.deepEqual(opened.state, { status: "failed" });
});

test("after a rename the next save writes the new path", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  const openedVersion = client.fileAt(PATH)?.version;
  assert.ok(openedVersion);
  const moved = "archive/intro.abc";
  client.setFile(moved, SAMPLE, openedVersion);
  session.dispatch({ type: "replaceScoreText", text: EDITED });

  assert.equal(host.relaunch({ spaceId: "space-1", path: moved }), "moved");
  assert.equal(host.name(), "intro.abc");
  assert.equal(host.path(), moved);
  const result = await keeper.save();

  assert.equal(result.ok, true);
  assert.equal(client.writesTo(PATH), 0);
  assert.deepEqual(client.writes[0]?.expected, openedVersion);
  assert.equal(client.fileAt(moved)?.text, EDITED);
  assert.equal(client.fileAt(PATH)?.text, SAMPLE);
});

test("the same file launched again changes nothing", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host } = await openIntro(client);
  assert.equal(host.relaunch({ spaceId: "space-1", path: PATH }), "same");
  assert.equal(client.writes.length, 0);
});

test("closing is only held back while changes are unsaved", () => {
  const client = createFakeClient();
  const host = createScoreHost({ client, language: "en" });
  assert.equal(host.allowClose(false), true);
  assert.equal(host.allowClose(true), false);
});

test("a read-only file can ask for edit access and becomes editable", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE }, scopes: ["file.view"] });
  const host = createScoreHost({ client, language: "en" });
  const opened = await host.openFile({ spaceId: "space-1", path: PATH });
  assert.ok(opened.ok);
  assert.equal(opened.kind, "scoreFile");
  assert.ok(opened.source);
  assert.equal(host.editable(), false);

  client.grant(["file.view", "file.edit"]);
  const outcome = await host.requestAccess();

  assert.equal(outcome, "granted");
  assert.equal(host.editable(), true);
  assert.deepEqual(client.calls.at(-1), {
    kind: "authorize",
    spaceId: "space-1",
    scopes: ["file.edit"],
    reason: "Edit score files in this Space.",
    fallback: "none",
  });
  assert.deepEqual(host.state(), { status: "ready", editable: true, name: "intro.abc", path: PATH });
});

test("a file that was never granted can ask for access again", async () => {
  const client = createFakeClient({
    files: { [PATH]: SAMPLE },
    authorizeSteps: ["cancelled", "granted"],
  });
  const host = createScoreHost({ client, language: "en" });
  const opened = await host.openFile({ spaceId: "space-1", path: PATH });
  assert.equal(opened.ok, false);

  const outcome = await host.requestAccess();

  assert.equal(outcome, "granted");
  assert.deepEqual(client.calls.at(-1), {
    kind: "authorize",
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
    fallback: "none",
  });
  const reopened = await host.openFile({ spaceId: "space-1", path: PATH });
  assert.ok(reopened.ok);
  assert.equal(reopened.editable, true);
});

test("a second consent that is cancelled or denied leaves the state as it was", async () => {
  for (const answer of ["cancelled", "denied"] as const) {
    const client = createFakeClient({
      files: { [PATH]: SAMPLE },
      authorizeSteps: ["cancelled", answer],
    });
    const host = createScoreHost({ client, language: "en" });
    await host.openFile({ spaceId: "space-1", path: PATH });

    const outcome = await host.requestAccess();

    assert.equal(outcome, answer);
    assert.deepEqual(host.state(), { status: "no-permission", reason: "missing" });
  }
});

test("after a revoke, a granted access makes the next save succeed", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.revoke();
  await keeper.save();
  assert.deepEqual(host.state(), { status: "no-permission", reason: "revoked" });

  client.grant(["file.view", "file.edit"]);
  assert.equal(await host.requestAccess(), "granted");
  assert.deepEqual(host.state(), { status: "ready", editable: true, name: "intro.abc", path: PATH });
  const saved = await keeper.save();

  assert.equal(saved.ok, true);
  assert.equal(client.fileAt(PATH)?.text, EDITED);
});

test("a save to a file that is gone reports the file as gone and keeps the edits", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.deleteFile(PATH);

  const result = await keeper.save();

  assert.deepEqual(result, { ok: false, reason: "failed" });
  assert.deepEqual(host.state(), { status: "file-gone" });
  assert.equal(session.project.score, EDITED);
  assert.equal(keeper.unsaved, true);
  assert.equal(host.allowClose(true), false);
});

test("a granted consent is reused silently for later calls", async () => {
  const client = createFakeClient({
    files: { [PATH]: SAMPLE },
    authorize: "cancelled",
    authorizeSteps: ["granted", "cancelled"],
  });
  const host = createScoreHost({ client, language: "en" });
  const first = await host.openFile({ spaceId: "space-1", path: PATH });
  assert.ok(first.ok);
  assert.equal(first.editable, true);

  const second = await host.openFile({ spaceId: "space-1", path: PATH });

  assert.ok(second.ok);
  assert.equal(second.editable, true);
});

test("a viewer who can only view is denied edit and keeps the view", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE }, scopes: ["file.view"] });
  const { host, opened } = await openIntro(client);
  assert.ok(opened.ok);
  assert.equal(opened.kind, "scoreFile");
  assert.ok(opened.source);
  assert.equal(opened.editable, false);

  const outcome = await host.requestAccess();

  assert.equal(outcome, "denied");
  assert.equal(host.editable(), false);
  const lastCall = client.calls.at(-1);
  assert.ok(lastCall?.kind === "authorize");
  assert.deepEqual(lastCall.scopes, ["file.edit"]);
  const reread = await host.openFile({ spaceId: "space-1", path: PATH });
  assert.ok(reread.ok);
  assert.equal(reread.editable, false);
});

test("a gone file with kept edits saves the same path as a new file without a version", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.deleteFile(PATH);
  await keeper.save();
  assert.deepEqual(host.state(), { status: "file-gone" });
  assert.equal(keeper.status, "dirty");
  assert.equal(keeper.failed, true);

  // The host armed the create when it found the file gone: the package's Save again puts it back.
  const saved = await keeper.save();

  assert.equal(saved.ok, true);
  assert.equal(client.writes.length, 2);
  const last = client.writes[1];
  assert.equal(last?.path, PATH);
  assert.equal(last?.text, EDITED);
  assert.equal(last?.expected, null);
  const recreated = client.fileAt(PATH);
  assert.ok(recreated);
  assert.equal(recreated.text, EDITED);
  assert.equal(keeper.version, `${recreated.version.mtimeMs}:${recreated.version.size}`);
  assert.equal(keeper.unsaved, false);
  assert.deepEqual(host.state(), { status: "ready", editable: true, name: "intro.abc", path: PATH });
  assert.equal(host.takeRecreated(), true);
  assert.equal(host.takeRecreated(), false);
});

test("a file that came back while the edits were kept gives the conflict choices", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.deleteFile(PATH);
  await keeper.save();
  client.setFile(PATH, THEIRS);
  const writesBefore = client.writes.length;

  const result = await keeper.save();

  assert.deepEqual(result, { ok: false, reason: "conflict" });
  assert.equal(client.writes.length, writesBefore);
  assert.equal(keeper.status, "conflict");
  assert.equal(client.fileAt(PATH)?.text, THEIRS);
  assert.deepEqual(host.state(), { status: "ready", editable: true, name: "intro.abc", path: PATH });
});

test("the fake follows cohub: a missing read is path_not_found and a versioned write is a conflict", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const version = client.fileAt(PATH)?.version;
  assert.ok(version);
  await client.authorize({ spaceId: "space-1", scopes: ["file.view", "file.edit"], reason: "" });
  client.deleteFile(PATH);

  await assert.rejects(
    () => client.read({ spaceId: "space-1", path: PATH }),
    (error: unknown) => statusAndCode(error, 404, "path_not_found"),
  );
  await assert.rejects(
    () => client.write({ spaceId: "space-1", path: PATH, text: EDITED, expected: version }),
    (error: unknown) => statusAndCode(error, 409, "file_conflict"),
  );
  const created = await client.write({ spaceId: "space-1", path: PATH, text: EDITED, expected: null });
  assert.ok(created.mtimeMs > version.mtimeMs);
  assert.equal(client.fileAt(PATH)?.text, EDITED);
});

function statusAndCode(error: unknown, status: number, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: number }).status === status &&
    (error as { code?: string }).code === code
  );
}

test("a deleted file with kept edits: use my version keeps the conflict and writes nothing", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.setFile(PATH, THEIRS);
  assert.deepEqual(await keeper.save(), { ok: false, reason: "conflict" });
  client.deleteFile(PATH);

  await keeper.overwrite();

  // 0.4.2's keeper needs an entry to overwrite; a missing read leaves the conflict standing.
  assert.equal(keeper.failed, true);
  assert.equal(keeper.status, "conflict");
  assert.equal(session.project.score, EDITED);
  assert.deepEqual(host.state(), { status: "file-gone" });
  assert.equal(client.writes.length, 1);
  assert.equal(client.fileAt(PATH), null);
});

test("a deleted file with kept edits: load their version never empties the editor", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.setFile(PATH, THEIRS);
  assert.deepEqual(await keeper.save(), { ok: false, reason: "conflict" });
  client.deleteFile(PATH);

  await keeper.loadTheirs();

  assert.equal(keeper.failed, false);
  assert.equal(session.project.score, EDITED);
  assert.notEqual(session.project.score, "");
  assert.deepEqual(host.state(), { status: "file-gone" });
});

test("after a create that found the file back, the next save is versioned again", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  const { session, keeper } = editorFor(opened);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.deleteFile(PATH);
  await keeper.save();
  client.setFile(PATH, THEIRS);
  await keeper.save();
  assert.equal(keeper.status, "conflict");

  await keeper.overwrite();

  const last = client.writes.at(-1);
  assert.ok(last?.expected);
  assert.equal(last.text, EDITED);
  assert.equal(client.fileAt(PATH)?.text, EDITED);
  assert.deepEqual(host.state(), { status: "ready", editable: true, name: "intro.abc", path: PATH });
});

test("a read that finds the file back disarms the create", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const { host, opened } = await openIntro(client);
  assert.ok(opened.ok && opened.kind === "scoreFile");
  const { session, keeper } = editorFor(opened);
  const openedVersion = client.fileAt(PATH)?.version;
  assert.ok(openedVersion);
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  client.deleteFile(PATH);
  await keeper.save();
  client.setFile(PATH, SAMPLE, openedVersion);

  // A read outside a save (the dialog's read) sees the file back; the next Save must be versioned.
  await opened.source.read();
  const saved = await keeper.save();

  assert.equal(saved.ok, true);
  const last = client.writes.at(-1);
  assert.ok(last?.expected);
  assert.deepEqual(last.expected, openedVersion);
  assert.deepEqual(host.state(), { status: "ready", editable: true, name: "intro.abc", path: PATH });
});

test("a file open asks for no fallback and refuses another Space", async () => {
  const client = createFakeClient({
    files: { [PATH]: SAMPLE },
    fallbackSpace: { id: "space-9", name: "Mine" },
    ignoreFallback: true,
  });
  const { opened } = await openIntro(client);

  assert.equal(opened.ok, false);
  assert.deepEqual(opened.state, { status: "no-permission", reason: "missing" });
  const first = client.calls.find((call) => call.kind === "authorize") as { fallback?: string } | undefined;
  assert.equal(first?.fallback, "none");
  assert.equal(client.reads(), 0);
});

test("an edit ask refuses another Space and keeps the file read-only", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE }, scopes: ["file.view"] });
  const original = client.authorize.bind(client);
  client.authorize = async (input) => {
    const answer = await original(input);
    return input.scopes.length === 1 && input.scopes[0] === "file.edit"
      ? { status: "granted", space: { id: "space-9", name: "Mine" }, scopes: ["file.edit"] }
      : answer;
  };
  const host = createScoreHost({ client, language: "en" });
  const opened = await host.openFile({ spaceId: "space-1", path: PATH });
  assert.ok(opened.ok);
  assert.equal(host.editable(), false);

  assert.equal(await host.requestAccess(), "denied");
  assert.equal(host.editable(), false);
  const last = client.calls.at(-1);
  assert.equal(last?.kind === "authorize" ? last.fallback : undefined, "none");
});
