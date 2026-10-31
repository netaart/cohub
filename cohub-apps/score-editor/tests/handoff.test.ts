import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_COMPOSER_CHIP_CONTENT_MAX_BYTES, APP_COMPOSER_CHIP_LABEL_MAX_LENGTH } from "@neta-art/cohub";
import {
  createDialectRegistry,
  createEditingSession,
  createScoreFileKeeper,
  formatDiagnostic,
  handoffInstruction,
  type HandoffPayload,
} from "@neta-art/score-editor";
import { song2Dialect } from "@neta-art/score-dialect-song2";
import { frameCopy } from "../src/app/copy.ts";
import {
  PACKAGE_NO_LYRICS,
  PACKAGE_NO_LYRICS_WITH_STYLE,
  PACKAGE_NO_STYLE,
  createHandoff,
  draftScorePath,
  handoffFilePath,
  handoffScorePath,
  withOriginalLyrics,
} from "../src/app/handoff.ts";
import { handoffNoticeFor, handoffNoticeText } from "../src/app/policy.ts";
import { createScoreHost } from "../src/host/host.ts";
import { FakeRequestError, createFakeClient } from "./fake-client.ts";

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
const TASK = "task-9";
const PATH = "scores/intro.abc";
const LONG_NAME = `${"a".repeat(196)}.abc`;
const MORNING_WALK = `X:1
T:
M:4/4
L:1/16
Q:1/4=100
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:C
% verse
V: Vocal
"C"c4e4g8|"Am"a4g4e4z4|
V: Ins
C2E2G2c2z8|A,2C2E2A2z8|
% chorus
V: Vocal
"F"f4a4c'8|"G"g4e4c4z4|
V: Ins
F,2A,2C2F2z8|G,2B,2D2G2z8|
`;
const MORNING_LYRICS = `[Verse]
Morning light on the window
[Chorus]
Walk with me to the corner`;
const MELODY = `X:1
T:
M:4/4
L:1/16
Q:1/4=120
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
K:C
V: Vocal
"G"C16|
`;
const DIALECTS = createDialectRegistry([song2Dialect]);

function payloadOf(score: string, instruction: string, scoreMode: "full" | "melody" = "full"): HandoffPayload {
  return {
    attachment: { name: "score.abc", mediaType: "text/plain", text: score },
    instruction,
    project: {
      style: "",
      lyrics: "",
      score,
      scoreMode,
      seed: null,
      modelId: "song2",
      sourceKey: `generated:${TASK}`,
    },
  };
}

test("a generated score is written beside its draft and becomes the composer chip", async () => {
  const client = createFakeClient();
  // The App has already asked for the Space when it opened the score, as every launch does.
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS });

  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "generated", taskRunId: TASK },
    title: "Night walk",
    language: "en",
    payload: payloadOf(SAMPLE, "Regenerate with this version."),
  });

  assert.deepEqual(result, { ok: true, path: ".cohub/score-drafts/task-9.abc" });
  assert.deepEqual(client.writes, [
    {
      kind: "write",
      spaceId: "space-1",
      path: ".cohub/score-drafts/task-9.abc",
      text: SAMPLE,
      expected: null,
    },
  ]);
  assert.equal(client.chips.length, 1);
  assert.equal(client.chips[0]?.label, "Night walk");
  assert.equal(
    client.chips[0]?.content,
    "Score file in this Space: `.cohub/score-drafts/task-9.abc`\n\nRegenerate with this version.",
  );
});

test("a score file's handoff without a composer writes the chip text to a file", async () => {
  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS, composer: false });

  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "scoreFile", path: PATH },
    title: "intro.abc",
    language: "en",
    payload: payloadOf(SAMPLE, "Regenerate with this version."),
  });

  assert.deepEqual(result, { ok: true, path: "scores/intro.handoff.md" });
  assert.equal(handoffFilePath(PATH), "scores/intro.handoff.md");
  assert.deepEqual(client.writes, [
    {
      kind: "write",
      spaceId: "space-1",
      path: "scores/intro.handoff.md",
      text: `Score file in this Space: \`${PATH}\`\n\nRegenerate with this version.`,
      expected: null,
    },
  ]);
  assert.equal(client.fileAt("scores/intro.handoff.md")?.text, client.writes[0]?.text);
  assert.equal(client.chips.length, 0);
  assert.equal(client.clearedChips.length, 0);
  handoff.clear();
  assert.equal(client.clearedChips.length, 0);
});

test("a generated score's handoff without a composer writes its .abc and the handoff file with its lyrics", async () => {
  const project = {
    style: "warm synthwave",
    lyrics: "[Instrumental]",
    score: MORNING_WALK,
    scoreMode: "full" as const,
    seed: null,
    modelId: "song2",
    sourceKey: "generated:task-9",
  };
  const instruction = handoffInstruction({
    original: project,
    current: project,
    title: "Instrumental Walk",
    language: "en",
    dialect: song2Dialect,
    scorePath: draftScorePath(TASK),
  });
  assert.match(instruction, /This score carries no lyrics/);
  const carried = withOriginalLyrics(
    {
      attachment: { name: "score.abc", mediaType: "text/plain", text: MORNING_WALK },
      instruction,
      project,
    },
    project.lyrics,
    "en",
  );
  const expected = `Score file in this Space: \`.cohub/score-drafts/task-9.abc\`

Title: Instrumental Walk

Regenerate with song2. Use the score in the file \`.cohub/score-drafts/task-9.abc\`, passed with --text.

The style description below is final and already synced by the editor; do not change it.

Lyrics:
[Instrumental]

Style description:
warm synthwave

Score mode: full

Changes:
No changes from the original.
`;
  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS, composer: false });
  const run = () =>
    handoff.run({
      spaceId: "space-1",
      target: { kind: "generated", taskRunId: TASK },
      title: "Instrumental Walk",
      language: "en",
      payload: carried,
    });

  const scorePath = `.cohub/score-drafts/${TASK}.abc`;
  const filePath = `.cohub/score-drafts/${TASK}.handoff.md`;
  const first = await run();
  assert.deepEqual(first, { ok: true, path: filePath });
  assert.deepEqual(client.writes, [
    { kind: "write", spaceId: "space-1", path: scorePath, text: MORNING_WALK, expected: null },
    { kind: "write", spaceId: "space-1", path: filePath, text: expected, expected: null },
  ]);
  const scoreFile = client.fileAt(scorePath);
  const handoffFile = client.fileAt(filePath);
  assert.ok(scoreFile && handoffFile);
  assert.equal(handoffFile.text, expected);
  assert.match(handoffFile.text, /Lyrics:\n\[Instrumental\]/);
  assert.doesNotMatch(handoffFile.text, /This score carries no lyrics/);
  assert.equal(client.chips.length, 0);

  const second = await run();
  assert.deepEqual(second, { ok: true, path: filePath });
  assert.deepEqual(client.writes.slice(2), [
    { kind: "write", spaceId: "space-1", path: scorePath, text: MORNING_WALK, expected: scoreFile.version },
    { kind: "write", spaceId: "space-1", path: filePath, text: expected, expected: handoffFile.version },
  ]);
});

test("the handoff file is created after a 404 and replaced at the read version", async () => {
  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS, composer: false });
  const run = (instruction: string) =>
    handoff.run({
      spaceId: "space-1",
      target: { kind: "scoreFile", path: PATH },
      title: "intro.abc",
      language: "en",
      payload: payloadOf(SAMPLE, instruction),
    });

  const first = await run("First version.");
  assert.deepEqual(first, { ok: true, path: "scores/intro.handoff.md" });
  const firstFile = client.fileAt("scores/intro.handoff.md");
  assert.ok(firstFile);
  assert.equal(client.writes[0]?.expected, null);

  const second = await run("Second version.");
  assert.deepEqual(second, { ok: true, path: "scores/intro.handoff.md" });
  assert.equal(client.writes[1]?.path, "scores/intro.handoff.md");
  assert.deepEqual(client.writes[1]?.expected, firstFile.version);
  assert.equal(
    client.fileAt("scores/intro.handoff.md")?.text,
    `Score file in this Space: \`${PATH}\`\n\nSecond version.`,
  );
});

test("a handoff file write that fails is reported as failed and sets no chip", async () => {
  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS, composer: false });
  client.failNextWrite(new FakeRequestError(500));

  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "scoreFile", path: PATH },
    title: "intro.abc",
    language: "en",
    payload: payloadOf(SAMPLE, "Regenerate with this version."),
  });

  assert.deepEqual(result, { ok: false, reason: "failed" });
  assert.equal(client.chips.length, 0);
  assert.equal(client.clearedChips.length, 0);
});

test("a handoff without a composer still navigates to the score in a working Space", async () => {
  const client = createFakeClient({ navigationHandled: true });
  await client.authorize({
    spaceId: "space-2",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS, composer: false });

  const result = await handoff.run({
    spaceId: "space-2",
    target: { kind: "scoreFile", path: PATH },
    title: "intro.abc",
    language: "en",
    payload: payloadOf(SAMPLE, "Regenerate with this version."),
    navigation: { spaceName: "Mine" },
  });

  assert.deepEqual(result, {
    ok: true,
    path: "scores/intro.handoff.md",
    navigation: "handled",
  });
  assert.equal(
    client.fileAt("scores/intro.handoff.md")?.text,
    `Score file in Mine: \`${PATH}\`\n\nRegenerate with this version.`,
  );
  assert.deepEqual(
    client.calls.find((call) => call.kind === "navigate"),
    { kind: "navigate", spaceId: "space-2", path: PATH },
  );
});

test("the handoff instruction carries Morning Walk's lyric lines through the App's chip", async () => {
  const project = {
    style: "",
    lyrics: MORNING_LYRICS,
    score: MORNING_WALK,
    scoreMode: "full" as const,
    seed: null,
    modelId: "song2",
    sourceKey: "morning-walk",
  };
  const instruction = handoffInstruction({
    original: project,
    current: project,
    title: "Morning Walk",
    language: "en",
    dialect: song2Dialect,
    scorePath: PATH,
  });
  const lyrics = "Joined lyrics:\n[verse]\nMorning light on the window\n[chorus]\nWalk with me to the corner";
  assert.ok(instruction.includes(lyrics), instruction);

  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS });
  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "scoreFile", path: PATH },
    title: "Morning Walk",
    language: "en",
    payload: {
      attachment: { name: "score.abc", mediaType: "text/plain", text: MORNING_WALK },
      instruction,
      project,
    },
  });

  assert.ok(result.ok);
  assert.ok((client.chips[0]?.content ?? "").includes(lyrics));
});

test("a score that fails the check hands nothing off and says where", async () => {
  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS });

  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "generated", taskRunId: TASK },
    title: "Night walk",
    language: "en",
    payload: payloadOf("this is not a score", "Regenerate with this version."),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "check");
  assert.match(result.problem === null ? "" : formatDiagnostic(result.problem, "en"), /line 1/);
  assert.equal(client.writes.length, 0);
  assert.equal(client.chips.length, 0);
});

test("a score file is saved first and the chip names that file", async () => {
  const client = createFakeClient({ files: { [PATH]: SAMPLE } });
  const host = createScoreHost({ client, language: "en" });
  const opened = await host.openFile({ spaceId: "space-1", path: PATH });
  assert.ok(opened.ok && opened.kind === "scoreFile");
  const session = createEditingSession({ project: opened.project, dialects: DIALECTS, language: "en" });
  const keeper = createScoreFileKeeper({ session, original: opened.project, source: opened.source });
  const edited = SAMPLE.replace("Q:1/4=190", "Q:1/4=96");
  session.dispatch({ type: "replaceScoreText", text: edited });
  // The package's own handoff: it saves the dirty file and only then calls the host.
  assert.equal(await keeper.handoff(), "saved");
  const payload: HandoffPayload = {
    attachment: { name: "score.abc", mediaType: "text/plain", text: session.project.score },
    instruction: handoffInstruction({
      original: opened.project,
      current: session.project,
      title: opened.name,
      language: "en",
      dialect: song2Dialect,
    }),
    project: session.project,
  };
  const handoff = createHandoff({ client, dialects: DIALECTS });
  const writes = client.writes.length;

  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "scoreFile", path: PATH },
    title: opened.name,
    language: "en",
    payload,
  });

  assert.deepEqual(result, { ok: true, path: PATH });
  assert.equal(client.fileAt(PATH)?.text, edited);
  assert.equal(client.writes.length, writes);
  assert.equal(client.chips.length, 1);
  assert.equal(client.chips[0]?.label, "intro.abc");
  assert.equal(client.chips[0]?.content, `Score file in this Space: \`${PATH}\`\n\n${payload.instruction}`);
  assert.match(client.chips[0]?.content ?? "", /Changes:\n- Tempo changed from 190 to 96 BPM\./);
});

test("a handoff without style or lyric lines names them as missing", async () => {
  const project = payloadOf(SAMPLE, "").project;
  const instruction = handoffInstruction({
    original: project,
    current: project,
    title: "Night walk",
    language: "en",
    dialect: song2Dialect,
    scorePath: PATH,
  });
  assert.doesNotMatch(instruction, /final and already synced/);
  assert.match(instruction, /carries no style description and no lyrics/);

  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS });
  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "scoreFile", path: PATH },
    title: "Night walk",
    language: "en",
    payload: { ...payloadOf(SAMPLE, instruction), instruction },
  });

  assert.ok(result.ok);
  const content = client.chips[0]?.content ?? "";
  assert.doesNotMatch(content, /final and already synced/);
  assert.match(content, /carries no style description and no lyrics/);
});

test("a pre-handoff notice does not stop the handoff", async () => {
  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS });

  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "generated", taskRunId: TASK },
    title: "Night walk",
    language: "en",
    payload: payloadOf(MELODY, "Regenerate with this version.", "melody"),
  });

  assert.deepEqual(result, { ok: true, path: ".cohub/score-drafts/task-9.abc" });
  assert.deepEqual(handoffNoticeFor(result), { kind: "ready" });
  assert.equal(client.writes.length, 1);
  assert.equal(client.writes[0]?.text, MELODY);
  assert.equal(client.chips.length, 1);
  assert.equal(client.chips[0]?.label, "Night walk");
});

test("a second handoff replaces the chip, and clearing takes it back", async () => {
  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS });
  const second = SAMPLE.replace("Q:1/4=190", "Q:1/4=128");

  await handoff.run({
    spaceId: "space-1",
    target: { kind: "generated", taskRunId: TASK },
    title: "Night walk",
    language: "en",
    payload: payloadOf(SAMPLE, "First version."),
  });
  const firstFile = client.fileAt(".cohub/score-drafts/task-9.abc");
  assert.ok(firstFile);

  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "generated", taskRunId: TASK },
    title: "Night walk (final)",
    language: "en",
    payload: payloadOf(second, "Second version."),
  });

  assert.deepEqual(result, { ok: true, path: ".cohub/score-drafts/task-9.abc" });
  assert.equal(client.chips.length, 2);
  assert.equal(client.chips[1]?.label, "Night walk (final)");
  assert.equal(
    client.chips[1]?.content,
    "Score file in this Space: `.cohub/score-drafts/task-9.abc`\n\nSecond version.",
  );
  assert.deepEqual(client.writes[1]?.expected, firstFile.version);
  assert.equal(client.fileAt(".cohub/score-drafts/task-9.abc")?.text, second);

  handoff.clear();
  handoff.clear();

  assert.deepEqual(client.clearedChips, [client.chips[1]?.key]);
});

test("a file name over the chip label limit still hands off", async () => {
  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS });
  const path = `scores/${LONG_NAME}`;

  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "scoreFile", path },
    title: LONG_NAME,
    language: "en",
    payload: payloadOf(SAMPLE, "Regenerate with this version."),
  });

  assert.deepEqual(result, { ok: true, path });
  assert.equal(client.chips.length, 1);
  const label = client.chips[0]?.label ?? "";
  assert.ok(label.length <= APP_COMPOSER_CHIP_LABEL_MAX_LENGTH, "the label fits the protocol");
  assert.ok(label.startsWith("a".repeat(20)), "the label keeps the start of the name");
  assert.ok(label.endsWith(".abc"), "the label keeps the end of the name");
  assert.ok(label.includes("…"), "the cut is shown");
  assert.equal(client.chips[0]?.content.includes(path), true);
});

test("content over the chip limit sets no chip and names the reason", async () => {
  const client = createFakeClient();
  await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS });

  const result = await handoff.run({
    spaceId: "space-1",
    target: { kind: "scoreFile", path: PATH },
    title: "intro.abc",
    language: "en",
    payload: payloadOf(SAMPLE, "x".repeat(APP_COMPOSER_CHIP_CONTENT_MAX_BYTES)),
  });

  assert.deepEqual(result, { ok: false, reason: "long" });
  assert.equal(client.chips.length, 0);
  const notice = handoffNoticeFor(result);
  assert.ok(notice);
  assert.equal(
    handoffNoticeText(notice, "en"),
    "Not sent: this score is too long to hand off as text. Shorten it, then try again.",
  );
  assert.equal(
    handoffNoticeText(notice, "zh"),
    "没有交接：这份乐谱太长，不能作为文字交给 agent。把乐谱改短一些，再试一次。",
  );
});

test("the chip's first line carries the .abc path in both languages and both targets", async () => {
  for (const language of ["en", "zh"] as const) {
    for (const target of [
      { kind: "scoreFile", path: PATH },
      { kind: "generated", taskRunId: TASK },
    ] as const) {
      const client = createFakeClient();
      await client.authorize({
        spaceId: "space-1",
        scopes: ["file.view", "file.edit"],
        reason: "Open and save score files in this Space.",
      });
      const handoff = createHandoff({ client, dialects: DIALECTS });
      const result = await handoff.run({
        spaceId: "space-1",
        target,
        title: "Night walk",
        language,
        payload: payloadOf(SAMPLE, "Regenerate with this version."),
      });

      assert.ok(result.ok);
      const content = client.chips[0]?.content ?? "";
      const firstLine = content.split("\n")[0] ?? "";
      const match = /`([^`\n]+\.abc)`/.exec(firstLine);
      assert.ok(match, `${language}/${target.kind}: ${firstLine}`);
      const expected = target.kind === "scoreFile" ? target.path : `.cohub/score-drafts/${TASK}.abc`;
      assert.equal(match[1], expected);
    }
  }
});

test("the chip and the instruction name the same .abc path for both score kinds", async () => {
  const project = payloadOf(SAMPLE, "").project;
  for (const language of ["en", "zh"] as const) {
    for (const scenario of [
      { kind: "generated" as const, taskRunId: TASK, filePath: null, expected: `.cohub/score-drafts/${TASK}.abc` },
      { kind: "scoreFile" as const, taskRunId: null, filePath: PATH, expected: PATH },
    ]) {
      const path = handoffScorePath(scenario);
      assert.equal(path, scenario.expected);
      const instruction = handoffInstruction({
        original: project,
        current: project,
        title: "Night walk",
        language,
        dialect: song2Dialect,
        ...(path === null ? {} : { scorePath: path }),
      });
      assert.ok(instruction.includes(`\`${scenario.expected}\``), instruction);

      const client = createFakeClient();
      await client.authorize({
        spaceId: "space-1",
        scopes: ["file.view", "file.edit"],
        reason: "Open and save score files in this Space.",
      });
      const handoff = createHandoff({ client, dialects: DIALECTS });
      const result = await handoff.run({
        spaceId: "space-1",
        target:
          scenario.kind === "generated"
            ? { kind: "generated", taskRunId: TASK }
            : { kind: "scoreFile", path: PATH },
        title: "Night walk",
        language,
        payload: { ...payloadOf(SAMPLE, instruction), instruction },
      });

      assert.ok(result.ok);
      const firstLine = (client.chips[0]?.content ?? "").split("\n")[0] ?? "";
      assert.ok(firstLine.includes(`\`${scenario.expected}\``), firstLine);
    }
  }
});

test("a handoff into another Space navigates to the saved file after the chip", async () => {
  const client = createFakeClient({ navigationHandled: true });
  await client.authorize({
    spaceId: "space-2",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS });

  const result = await handoff.run({
    spaceId: "space-2",
    target: { kind: "generated", taskRunId: TASK },
    title: "Night walk",
    language: "en",
    payload: payloadOf(SAMPLE, "Regenerate with this version."),
    navigation: { spaceName: "Mine" },
  });

  assert.deepEqual(result, {
    ok: true,
    path: ".cohub/score-drafts/task-9.abc",
    navigation: "handled",
  });
  assert.equal(client.chips.length, 1);
  assert.equal(
    client.chips[0]?.content.split("\n")[0],
    "Score file in Mine: `.cohub/score-drafts/task-9.abc`",
  );
  assert.deepEqual(
    client.calls.find((call) => call.kind === "navigate"),
    { kind: "navigate", spaceId: "space-2", path: ".cohub/score-drafts/task-9.abc" },
  );
});

test("a navigation the host does not handle keeps the chip and says where the score is", async () => {
  const client = createFakeClient({ navigationHandled: false });
  await client.authorize({
    spaceId: "space-2",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  const handoff = createHandoff({ client, dialects: DIALECTS });

  const result = await handoff.run({
    spaceId: "space-2",
    target: { kind: "scoreFile", path: "scores/intro.abc" },
    title: "intro.abc",
    language: "en",
    payload: payloadOf(SAMPLE, "Regenerate with this version."),
    navigation: { spaceName: "Mine" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.navigation, "not-handled");
  assert.equal(client.chips.length, 1);
  assert.equal(client.clearedChips.length, 0);
});

test("a handoff after a fallback grant writes and navigates in that Space", async () => {
  const client = createFakeClient({ fallbackSpace: { id: "space-9", name: "Visitor World" } });
  const access = await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view", "file.edit"],
    reason: "Open and save score files in this Space.",
  });
  assert.equal(access.status, "granted");
  if (access.status !== "granted") throw new Error("no grant");
  assert.equal(access.space.id, "space-9");

  const handoff = createHandoff({ client, dialects: DIALECTS });
  const result = await handoff.run({
    spaceId: access.space.id,
    target: { kind: "generated", taskRunId: TASK },
    title: "Night walk",
    language: "en",
    payload: payloadOf(SAMPLE, "Regenerate with this version."),
    navigation: { spaceName: access.space.name },
  });

  assert.deepEqual(result, {
    ok: true,
    path: `.cohub/score-drafts/${TASK}.abc`,
    navigation: "handled",
  });
  assert.ok(client.writes.length > 0);
  assert.ok(client.writes.every((write) => write.spaceId === "space-9"));
  assert.deepEqual(
    client.calls.find((call) => call.kind === "navigate"),
    { kind: "navigate", spaceId: "space-9", path: `.cohub/score-drafts/${TASK}.abc` },
  );
});

function projectWithLyrics(lyrics: string) {
  return { ...payloadOf(SAMPLE, "").project, lyrics };
}

test("ordinary lyrics are left to the package's single joined block", () => {
  const project = projectWithLyrics("[Verse]\nNeon lights");
  const instruction = handoffInstruction({
    original: project,
    current: project,
    title: "Night walk",
    language: "en",
    dialect: song2Dialect,
    scorePath: PATH,
  });
  const payload = {
    attachment: { name: "score.abc" as const, mediaType: "text/plain" as const, text: SAMPLE },
    instruction,
    project,
  };
  assert.equal(withOriginalLyrics(payload, project.lyrics, "en").instruction, instruction);
  assert.equal(instruction.match(/Joined lyrics:/g)?.length, 1);
});

test("an instrumental gets its task lyrics in place of the package's missing-lyrics line", () => {
  for (const language of ["en", "zh"] as const) {
    const project = { ...projectWithLyrics("[Instrumental]"), style: "warm synthwave" };
    const instruction = handoffInstruction({
      original: project,
      current: project,
      title: "Night walk",
      language,
      dialect: song2Dialect,
      scorePath: PATH,
    });
    assert.ok(instruction.includes(PACKAGE_NO_LYRICS[language]));
    const payload = {
      attachment: { name: "score.abc" as const, mediaType: "text/plain" as const, text: SAMPLE },
      instruction,
      project,
    };
    const carried = withOriginalLyrics(payload, project.lyrics, language);
    const copy = frameCopy(language);
    assert.ok(carried.instruction.includes("[Instrumental]"));
    assert.ok(carried.instruction.includes(`${copy.handoffLyrics}:`));
    assert.equal(carried.instruction.includes(PACKAGE_NO_LYRICS[language]), false);
  }
});

test("PACKAGE_NO_STYLE matches the package's no-style sentence", () => {
  for (const language of ["en", "zh"] as const) {
    const project = { ...projectWithLyrics("Hello there"), style: "" };
    const instruction = handoffInstruction({
      original: project,
      current: project,
      title: "Night walk",
      language,
      dialect: song2Dialect,
      scorePath: PATH,
    });
    assert.ok(instruction.includes(PACKAGE_NO_STYLE[language]));
  }
});

test("a combined no-style/no-lyrics line keeps the no-style ask beside the lyrics", () => {
  for (const language of ["en", "zh"] as const) {
    const project = projectWithLyrics("[Instrumental]");
    const instruction = handoffInstruction({
      original: project,
      current: project,
      title: "Night walk",
      language,
      dialect: song2Dialect,
      scorePath: PATH,
    });
    assert.ok(instruction.includes(PACKAGE_NO_LYRICS_WITH_STYLE[language]));
    const carried = withOriginalLyrics(
      {
        attachment: { name: "score.abc", mediaType: "text/plain", text: SAMPLE },
        instruction,
        project,
      },
      project.lyrics,
      language,
    );
    const copy = frameCopy(language);
    assert.ok(carried.instruction.includes(PACKAGE_NO_STYLE[language]));
    assert.ok(carried.instruction.includes(`${copy.handoffLyrics}:`));
    assert.ok(carried.instruction.includes("[Instrumental]"));
    assert.equal(carried.instruction.includes(PACKAGE_NO_LYRICS_WITH_STYLE[language]), false);
  }
});

test("words added in the editor reach the chip without the old instrumental block", () => {
  const original = projectWithLyrics("[Instrumental]");
  const current = projectWithLyrics("Hello");
  const instruction = handoffInstruction({
    original,
    current,
    title: "Night walk",
    language: "en",
    dialect: song2Dialect,
    scorePath: PATH,
  });
  const carried = withOriginalLyrics(
    {
      attachment: { name: "score.abc", mediaType: "text/plain", text: SAMPLE },
      instruction,
      project: current,
    },
    original.lyrics,
    "en",
  );
  assert.equal(carried.instruction, instruction);
  assert.ok(carried.instruction.includes("Hello"));
  assert.doesNotMatch(carried.instruction, /Lyrics:\n\[Instrumental\]/);
});
