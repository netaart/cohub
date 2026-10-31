import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDialectRegistry,
  createDraftKeeper,
  createEditingSession,
  handoffInstruction,
  type DraftStore,
  type LyricLine,
} from "@neta-art/score-editor";
import { song2Dialect } from "@neta-art/score-dialect-song2";
import { createHandoff } from "../src/app/handoff.ts";
import { editorOptionsFor } from "../src/app/options.ts";
import { failurePresentation } from "../src/app/policy.ts";
import { createScoreHost, type OpenedScore } from "../src/host/host.ts";
import { draftPath } from "../src/host/drafts.ts";
import type { TaskRunSnapshot } from "../src/host/task.ts";
import { createFakeClient } from "./fake-client.ts";

const SAMPLE = `X:1
T:
M:4/4
L:1/16
Q:1/4=190
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:E
% Verse
V: Vocal
z12e2e2|b6b4e4f2-|f4g4z4e4|b6b4e2-e2f2-|
V: Ins
Z4|
`;
const EDITED = SAMPLE.replace("z12e2e2", "z12f2e2");
const THEIRS = SAMPLE.replace("z12e2e2", "z12d2e2");
const LYRICS = "[Verse]\nNeon lights";
// Two bars of the four-bar verse: an arrangement the user made, unlike the layout the lyrics text gives (the whole verse).
const LINES: LyricLine[] = [{ text: "Neon lights", phrase: { firstBar: 0, barCount: 2 } }];

function draftsOf(score: OpenedScore): DraftStore {
  assert.equal(score.kind, "generated");
  assert.ok(score.drafts);
  return score.drafts;
}

function saveAsOf(score: OpenedScore): (text: string) => Promise<unknown> {
  assert.equal(score.kind, "generated");
  assert.ok(score.saveAs);
  return score.saveAs;
}

function task(id: string, options: {
  score?: string;
  inputScore?: string | null;
  lyrics?: string;
  parameters?: Record<string, unknown>;
} = {}): TaskRunSnapshot {
  const content: unknown[] = [
    { type: "text", text: "warm synthwave", meta: { role: "prompt" } },
    { type: "text", text: options.lyrics ?? LYRICS, meta: { role: "lyrics" } },
  ];
  const inputScore = options.inputScore === undefined ? SAMPLE : options.inputScore;
  if (inputScore !== null) {
    content.push({ type: "text", text: inputScore, meta: { role: "abc" } });
  }
  return {
    id,
    spaceId: "space-1",
    status: "completed",
    payload: {
      data: {
        model: "song2",
        content,
        parameters: options.parameters ?? { seed: 42 },
      },
    },
    result: {
      output: options.score === undefined ? [{ type: "text", text: SAMPLE, meta: { role: "abc" } }] : [{ type: "text", text: options.score, meta: { role: "abc" } }],
    },
  };
}

async function openGenerated(client: ReturnType<typeof createFakeClient>, options: {
  id?: string;
  scopes?: readonly string[];
  file?: { spaceId: string; path: string } | null;
}) {
  if (options.scopes) client.grant(options.scopes);
  const host = createScoreHost({ client, language: "en" });
  const opened = await host.openGenerated({
    spaceId: "space-1",
    taskRunId: options.id ?? "task-1",
    file: options.file ?? null,
  });
  return { host, opened };
}

test("opening a task run asks for the file scopes and taskrun.view, then builds the project", async () => {
  const client = createFakeClient({ tasks: { "task-1": task("task-1") } });
  const { opened } = await openGenerated(client, {});

  assert.deepEqual(client.calls[0], {
    kind: "authorize",
    spaceId: "space-1",
    scopes: ["file.view", "file.edit", "taskrun.view"],
    reason: "Open this generated score in this Space.",
    fallback: "none",
  });
  assert.deepEqual(client.calls[1], { kind: "task", taskRunId: "task-1" });
  assert.ok(opened.ok);
  assert.equal(opened.kind, "generated");
  assert.equal(opened.name, "Neon lights");
  assert.equal(opened.project.style, "warm synthwave");
  assert.equal(opened.project.lyrics, LYRICS);
  assert.equal(opened.project.score, SAMPLE);
  assert.equal(opened.project.seed, 42);
  assert.equal(opened.project.sourceKey, "task-1");
  assert.equal(opened.editable, true);
  assert.ok(opened.drafts);
  assert.ok(opened.saveAs);
  assert.equal(opened.path, null);
});

test("a read-only generated mount still passes its kind", async () => {
  const client = createFakeClient({ tasks: { "task-1": task("task-1") } });
  const { opened } = await openGenerated(client, { scopes: ["file.view", "taskrun.view"] });

  assert.ok(opened.ok);
  assert.deepEqual(editorOptionsFor(opened, "en").source, { kind: "generated" });
});

test("a read-only generated score never reads or lists a draft", async () => {
  const client = createFakeClient({
    tasks: { "task-1": task("task-1") },
    files: { [draftPath("task-1")]: "a draft" },
  });
  const { opened } = await openGenerated(client, {
    scopes: ["file.view", "taskrun.view"],
  });

  assert.ok(opened.ok);
  assert.equal(opened.kind, "generated");
  assert.equal(opened.editable, false);
  assert.equal(opened.project.score, SAMPLE);
  assert.equal(opened.drafts, undefined);
  assert.equal(opened.saveAs, undefined);
  assert.equal(
    client.calls.some(
      (call) =>
        (call.kind === "read" || call.kind === "list" || call.kind === "write" || call.kind === "delete") &&
        call.path.startsWith(".cohub/"),
    ),
    false,
  );
});

test("a viewer without taskrun.view is told access is missing and no task is read", async () => {
  const client = createFakeClient({ tasks: { "task-1": task("task-1") } });
  const { opened } = await openGenerated(client, {
    scopes: ["file.view", "file.edit"],
  });

  assert.equal(opened.ok, false);
  assert.deepEqual(opened.state, { status: "no-permission", reason: "missing" });
  assert.equal(client.calls.some((call) => call.kind === "task"), false);
});

test("a generated score opened with a file keeps the file as the Save as place", async () => {
  const client = createFakeClient({
    tasks: { "task-1": task("task-1") },
    files: { "projects/morning-walk.abc": SAMPLE },
  });
  const { opened } = await openGenerated(client, {
    file: { spaceId: "space-1", path: "projects/morning-walk.abc" },
  });

  assert.ok(opened.ok);
  assert.equal(opened.kind, "generated");
  assert.equal(opened.path, "projects/morning-walk.abc");
  assert.equal(client.calls.some((call) => call.kind === "read" && call.path === "projects/morning-walk.abc"), false);
});

test("Save as from the opened generation writes beside the source file", async () => {
  const client = createFakeClient({
    tasks: { "task-1": task("task-1") },
    files: { "projects/morning-walk.abc": SAMPLE },
  });
  const { opened } = await openGenerated(client, {
    file: { spaceId: "space-1", path: "projects/morning-walk.abc" },
  });
  assert.ok(opened.ok);
  assert.equal(opened.kind, "generated");

  const result = await saveAsOf(opened)(EDITED);

  assert.deepEqual(result, { ok: true, path: "projects/morning-walk-copy.abc" });
  assert.equal(client.fileAt("projects/morning-walk-copy.abc")?.text, EDITED);
  assert.equal(client.fileAt("projects/morning-walk.abc")?.text, SAMPLE);
});

test("Save as after a relaunch writes beside the new file", async () => {
  const client = createFakeClient({
    tasks: { "task-1": task("task-1") },
    files: { "projects/morning-walk.abc": SAMPLE },
  });
  const { host, opened } = await openGenerated(client, {
    file: { spaceId: "space-1", path: "projects/morning-walk.abc" },
  });
  assert.ok(opened.ok);
  assert.equal(opened.kind, "generated");
  host.relaunch({ spaceId: "space-1", path: "projects/other.abc" });

  const result = await saveAsOf(opened)(EDITED);

  assert.deepEqual(result, { ok: true, path: "projects/other-copy.abc" });
});

test("Save as from a launch without a file writes into scores/", async () => {
  const client = createFakeClient({ tasks: { "task-1": task("task-1") } });
  const { opened } = await openGenerated(client, {});
  assert.ok(opened.ok);
  assert.equal(opened.kind, "generated");

  const result = await saveAsOf(opened)(EDITED);

  assert.deepEqual(result, { ok: true, path: "scores/Neon lights.abc" });
});

test("a draft written through the package lands at .cohub/score-drafts/<task>.json", async () => {
  const client = createFakeClient({ tasks: { "task-1": task("task-1") } });
  const { opened } = await openGenerated(client, {});
  assert.ok(opened.ok);
  assert.equal(opened.kind, "generated");
  const session = createEditingSession({
    project: opened.project,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const keeper = createDraftKeeper({
    session,
    store: draftsOf(opened),
    original: opened.project,
    debounceMs: 1,
  });
  await keeper.ready;
  session.dispatch({ type: "replaceScoreText", text: EDITED });

  assert.equal(await keeper.handoff(), "written");
  const file = client.fileAt(draftPath("task-1"));
  assert.ok(file);
  assert.match(file.text, /"sourceKey":"task-1"/);
  assert.match(file.text, /z12f2e2/);
  keeper.destroy();
});

test("a second window's first draft write conflicts instead of overwriting", async () => {
  const client = createFakeClient({ tasks: { "task-1": task("task-1") } });
  const first = await openGenerated(client, {});
  const second = await openGenerated(client, {});
  assert.ok(first.opened.ok);
  assert.equal(first.opened.kind, "generated");
  assert.ok(second.opened.ok);
  assert.equal(second.opened.kind, "generated");
  const project = first.opened.project;
  const sessionA = createEditingSession({ project, dialects: createDialectRegistry([song2Dialect]), language: "en" });
  const keeperA = createDraftKeeper({ session: sessionA, store: draftsOf(first.opened), original: project, debounceMs: 1 });
  const sessionB = createEditingSession({ project, dialects: createDialectRegistry([song2Dialect]), language: "en" });
  const keeperB = createDraftKeeper({ session: sessionB, store: draftsOf(second.opened), original: project, debounceMs: 1 });
  await Promise.all([keeperA.ready, keeperB.ready]);
  sessionA.dispatch({ type: "replaceScoreText", text: EDITED });
  assert.equal(await keeperA.handoff(), "written");

  sessionB.dispatch({ type: "replaceScoreText", text: THEIRS });
  assert.equal(await keeperB.handoff(), "conflict");

  assert.equal(keeperB.status, "conflict");
  assert.match(client.fileAt(draftPath("task-1"))?.text ?? "", /z12f2e2/);
  keeperA.destroy();
  keeperB.destroy();
});

test("a handed-off draft is inherited by a regenerated song with the same lyrics and score", async () => {
  const client = createFakeClient({
    tasks: {
      "task-old": task("task-old"),
      "task-new": task("task-new", { inputScore: EDITED, score: "" }),
    },
  });
  const old = await openGenerated(client, { id: "task-old", file: null });
  assert.ok(old.opened.ok);
  assert.equal(old.opened.kind, "generated");
  const oldProject = { ...old.opened.project, lyricLines: LINES };
  const oldSession = createEditingSession({
    project: oldProject,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const oldKeeper = createDraftKeeper({
    session: oldSession,
    store: draftsOf(old.opened),
    original: oldProject,
    debounceMs: 1,
  });
  await oldKeeper.ready;
  oldSession.dispatch({ type: "replaceScoreText", text: EDITED });
  assert.equal(await oldKeeper.handoff(), "written");
  oldKeeper.destroy();

  const next = await openGenerated(client, { id: "task-new", file: null });
  assert.ok(next.opened.ok);
  assert.equal(next.opened.kind, "generated");
  assert.equal(next.opened.project.score, EDITED);
  const nextSession = createEditingSession({
    project: next.opened.project,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const nextKeeper = createDraftKeeper({
    session: nextSession,
    store: draftsOf(next.opened),
    original: next.opened.project,
    debounceMs: 1,
  });
  await nextKeeper.ready;

  assert.deepEqual(nextSession.project.lyricLines, LINES);
  nextKeeper.destroy();
});

test("a regenerated song with other lyrics does not inherit", async () => {
  const client = createFakeClient({
    tasks: {
      "task-old": task("task-old"),
      "task-new": task("task-new", { inputScore: EDITED, score: "", lyrics: "Other words" }),
    },
  });
  const old = await openGenerated(client, { id: "task-old", file: null });
  assert.ok(old.opened.ok);
  assert.equal(old.opened.kind, "generated");
  const oldProject = { ...old.opened.project, lyricLines: LINES };
  const oldSession = createEditingSession({
    project: oldProject,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const oldKeeper = createDraftKeeper({
    session: oldSession,
    store: draftsOf(old.opened),
    original: oldProject,
    debounceMs: 1,
  });
  await oldKeeper.ready;
  oldSession.dispatch({ type: "replaceScoreText", text: EDITED });
  await oldKeeper.handoff();
  oldKeeper.destroy();

  const next = await openGenerated(client, { id: "task-new", file: null });
  assert.ok(next.opened.ok);
  assert.equal(next.opened.kind, "generated");
  const nextSession = createEditingSession({
    project: next.opened.project,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const nextKeeper = createDraftKeeper({
    session: nextSession,
    store: draftsOf(next.opened),
    original: next.opened.project,
    debounceMs: 1,
  });
  await nextKeeper.ready;

  assert.equal(nextSession.project.lyricLines, undefined);
  nextKeeper.destroy();
});

test("restoring the original puts the generation back and removes the draft", async () => {
  const client = createFakeClient({ tasks: { "task-1": task("task-1") } });
  const { opened } = await openGenerated(client, {});
  assert.ok(opened.ok);
  assert.equal(opened.kind, "generated");
  const session = createEditingSession({
    project: opened.project,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const keeper = createDraftKeeper({
    session,
    store: draftsOf(opened),
    original: opened.project,
    debounceMs: 1,
  });
  await keeper.ready;
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  await keeper.handoff();
  assert.ok(client.fileAt(draftPath("task-1")));

  const restored = await keeper.restoreOriginal();

  assert.equal(restored, true);
  assert.equal(session.project.score, SAMPLE);
  assert.equal(client.fileAt(draftPath("task-1")), null);
  keeper.destroy();
});

test("a generated handoff writes the sidecar after the draft hash and a regenerated task inherits it", async () => {
  const client = createFakeClient({
    tasks: {
      "task-old": task("task-old"),
      "task-new": task("task-new", { inputScore: EDITED, score: "" }),
    },
  });
  const old = await openGenerated(client, { id: "task-old", file: null });
  assert.ok(old.opened.ok);
  assert.equal(old.opened.kind, "generated");
  const project = { ...old.opened.project, lyricLines: LINES };
  const session = createEditingSession({
    project,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const keeper = createDraftKeeper({
    session,
    store: draftsOf(old.opened),
    original: project,
    debounceMs: 1,
  });
  await keeper.ready;
  session.dispatch({ type: "replaceScoreText", text: EDITED });
  assert.equal(await keeper.handoff(), "written");
  const draft = client.fileAt(draftPath("task-old"));
  assert.ok(draft);
  const stored = JSON.parse(draft.text) as { handoffHash: string | null };
  assert.ok(stored.handoffHash);

  const handoff = createHandoff({
    client,
    dialects: createDialectRegistry([song2Dialect]),
  });
  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "generated", taskRunId: "task-old" },
    title: "Old song",
    language: "en",
    payload: {
      attachment: { name: "score.abc", mediaType: "text/plain", text: EDITED },
      instruction: handoffInstruction({
        original: project,
        current: session.project,
        title: "Old song",
        language: "en",
        dialect: song2Dialect,
      }),
      project: session.project,
    },
  });
  keeper.destroy();

  assert.deepEqual(result, { ok: true, path: ".cohub/score-drafts/task-old.abc" });
  assert.equal(client.fileAt(".cohub/score-drafts/task-old.abc")?.text, EDITED);
  assert.ok((client.chips[0]?.content ?? "").split("\n")[0]?.includes("`.cohub/score-drafts/task-old.abc`"));

  const next = await openGenerated(client, { id: "task-new", file: null });
  assert.ok(next.opened.ok);
  assert.equal(next.opened.kind, "generated");
  assert.equal(next.opened.project.score, EDITED);
});

test("a handed-off draft survives a score that lost its final line break", async () => {
  const withoutLastBreak = EDITED.replace(/\n$/, "");
  const changedInside = withoutLastBreak.replace("z12f2e2", "z12d2e2");
  const client = createFakeClient({
    tasks: {
      "task-1": task("task-1"),
      "task-2": task("task-2", { inputScore: EDITED, score: withoutLastBreak }),
      "task-3": task("task-3", { inputScore: EDITED, score: changedInside }),
    },
  });
  const first = await openGenerated(client, { id: "task-1" });
  assert.ok(first.opened.ok);
  assert.equal(first.opened.kind, "generated");
  const project = { ...first.opened.project, lyricLines: LINES };
  const firstSession = createEditingSession({
    project,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const firstKeeper = createDraftKeeper({
    session: firstSession,
    store: draftsOf(first.opened),
    original: project,
    debounceMs: 1,
  });
  await firstKeeper.ready;
  firstSession.dispatch({ type: "replaceScoreText", text: EDITED });
  assert.equal(await firstKeeper.handoff(), "written");
  const handoff = createHandoff({ client, dialects: createDialectRegistry([song2Dialect]) });
  assert.deepEqual(
    await handoff.run({
      spaceId: "space-1",
      target: { kind: "generated", taskRunId: "task-1" },
      title: "Morning walk",
      language: "en",
      payload: {
        attachment: { name: "score.abc", mediaType: "text/plain", text: EDITED },
        instruction: handoffInstruction({
          original: project,
          current: firstSession.project,
          title: "Morning walk",
          language: "en",
          dialect: song2Dialect,
        }),
        project: firstSession.project,
      },
    }),
    { ok: true, path: ".cohub/score-drafts/task-1.abc" },
  );
  firstKeeper.destroy();

  const second = await openGenerated(client, { id: "task-2" });
  assert.ok(second.opened.ok);
  assert.equal(second.opened.kind, "generated");
  const secondSession = createEditingSession({
    project: second.opened.project,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const secondKeeper = createDraftKeeper({
    session: secondSession,
    store: draftsOf(second.opened),
    original: second.opened.project,
    debounceMs: 1,
  });
  await secondKeeper.ready;
  assert.deepEqual(secondSession.project.lyricLines, LINES);
  assert.equal(await secondKeeper.handoff(), "written");
  assert.ok(client.fileAt(draftPath("task-2")));
  secondKeeper.destroy();

  const third = await openGenerated(client, { id: "task-3" });
  assert.ok(third.opened.ok);
  assert.equal(third.opened.kind, "generated");
  const thirdSession = createEditingSession({
    project: third.opened.project,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const thirdKeeper = createDraftKeeper({
    session: thirdSession,
    store: draftsOf(third.opened),
    original: third.opened.project,
    debounceMs: 1,
  });
  await thirdKeeper.ready;
  assert.equal(thirdSession.project.lyricLines, undefined);
  thirdKeeper.destroy();
});

test("a task that is not found says the generation is unavailable", async () => {
  const client = createFakeClient({ tasks: {} });
  const host = createScoreHost({ client, language: "en" });
  const opened = await host.openGenerated({
    spaceId: "space-1",
    taskRunId: "missing",
    file: null,
  });

  assert.equal(opened.ok, false);
  assert.deepEqual(host.state(), { status: "task-gone" });
  const copy = failurePresentation({ status: "task-gone" } as never, {
    unsaved: false,
    name: "",
    language: "en",
  });
  assert.equal(copy.title, "This generation isn’t available.");
  assert.equal(copy.body, "Nothing was changed.");
});
