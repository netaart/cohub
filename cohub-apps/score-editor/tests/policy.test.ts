import assert from "node:assert/strict";
import { test } from "node:test";
import { editorNotice, failurePresentation, folderLabel, folderLine, handoffNoticeFor, handoffNoticeText, launchChoice, leaveNeedsGuard, stateCopy } from "../src/app/policy.ts";
import { folderOf } from "../src/host/path.ts";
import { fillCopy, frameCopy } from "../src/app/copy.ts";

const GONE = { status: "file-gone" } as const;
const REVOKED = { status: "no-permission", reason: "revoked" } as const;
const MISSING = { status: "no-permission", reason: "missing" } as const;
const FAILED = { status: "failed" } as const;

test("another file's launch waits while this window has unsaved edits", () => {
  assert.equal(launchChoice("other", true), "hold");
  assert.equal(launchChoice("other", false), "other");
  assert.equal(launchChoice("moved", true), "moved");
  assert.equal(launchChoice("same", true), "same");
});

test("a failure keeps the editor only when the score has unsaved changes", () => {
  assert.equal(failurePresentation(GONE, { unsaved: true, name: "a.abc", language: "en" }).keepEditor, true);
  assert.equal(failurePresentation(GONE, { unsaved: false, name: "a.abc", language: "en" }).keepEditor, false);
});

test("a revoked failure with edits names the cause, the kept edits and the next step", () => {
  const shown = failurePresentation(REVOKED, { unsaved: true, name: "a.abc", language: "en" });
  assert.match(shown.body, /Access to a\.abc was removed/);
  assert.match(shown.body, /Your changes are still here/);
  assert.match(shown.body, /Ask for access, then save again/);
  assert.equal(shown.action, "access");
});

test("every state with unsaved edits keeps the editor mounted", () => {
  for (const state of [REVOKED, MISSING, FAILED, GONE] as const) {
    assert.equal(failurePresentation(state, { unsaved: true, name: "a.abc", language: "en" }).keepEditor, true);
  }
});

test("a failure without edits says nothing was changed", () => {
  const gone = failurePresentation(GONE, { unsaved: false, name: "a.abc", language: "en" });
  assert.match(gone.body, /Nothing was changed\./);
  assert.match(gone.body, /If it was moved, open it again from the Space/);
  assert.equal(gone.action, "close");
  const failed = failurePresentation(FAILED, { unsaved: false, name: "a.abc", language: "en" });
  assert.match(failed.body, /Nothing was changed/);
  assert.equal(failed.action, "retry");
});

test("failure titles name the cause", () => {
  assert.equal(
    failurePresentation(MISSING, { unsaved: false, name: "a.abc", language: "en" }).title,
    "Access needed to open a.abc",
  );
  assert.equal(
    failurePresentation(FAILED, { unsaved: false, name: "a.abc", language: "en" }).title,
    "Couldn’t read a.abc",
  );
  assert.equal(
    failurePresentation(MISSING, { unsaved: false, name: "a.abc", language: "zh" }).title,
    "需要权限才能打开 a.abc",
  );
  assert.equal(
    failurePresentation(FAILED, { unsaved: false, name: "a.abc", language: "zh" }).title,
    "没能读取 a.abc",
  );
});

test("permission failures name the file and offer access", () => {
  const missing = failurePresentation(MISSING, { unsaved: false, name: "morning-walk.abc", language: "en" });
  assert.match(missing.title, /morning-walk\.abc/);
  assert.equal(missing.action, "access");
  const revoked = failurePresentation(REVOKED, { unsaved: false, name: "morning-walk.abc", language: "en" });
  assert.match(revoked.title, /morning-walk\.abc/);
  assert.match(revoked.body, /morning-walk\.abc/);
  assert.doesNotMatch(revoked.body, /reload/i);
});

test("file gone names the file and does not assume a move", () => {
  const gone = failurePresentation(GONE, { unsaved: false, name: "a.abc", language: "en" });
  assert.match(gone.title, /a\.abc/);
  assert.doesNotMatch(gone.body, /new place|moved to/i);
});

test("the state copy is in both languages and names the file while loading", () => {
  assert.match(stateCopy("loading", "a.abc", "en").title, /a\.abc/);
  assert.match(stateCopy("loading", "a.abc", "zh").title, /a\.abc/);
  assert.match(stateCopy("no-file", null, "en").body, /score file/i);
  assert.match(stateCopy("no-host", null, "zh").body, /乐谱文件/);
});

test("a file at the Space root has no folder line", () => {
  assert.equal(folderOf("morning-walk.abc"), "");
  assert.equal(folderLabel("morning-walk.abc"), null);
  assert.equal(folderOf("scores/morning-walk.abc"), "scores");
});

test("a deep folder keeps its first and last folders", () => {
  const path = "projects/2026/morning-walk/scores/drafts/morning-walk.abc";
  const label = folderLabel(path, 28);
  assert.equal(label, "projects/…/drafts");
  assert.ok(label.length <= 28);
});



test("kept edits without edit access say who must grant edit access", () => {
  const kept = editorNotice({ unsaved: true, editable: false, message: null, name: "intro.abc", language: "en" });
  assert.ok(kept);
  assert.match(kept.text, /You can view intro\.abc but not change it/);
  assert.match(kept.text, /Your changes are still here/);
  assert.equal(kept.action, "edit");
  const viewOnly = editorNotice({ unsaved: false, editable: false, message: null, name: "intro.abc", language: "en" });
  assert.ok(viewOnly);
  assert.match(viewOnly.text, /view intro\.abc/i);
  assert.equal(viewOnly.action, "edit");
  assert.equal(editorNotice({ unsaved: true, editable: true, message: null, name: "intro.abc", language: "en" }), null);
  const denied = editorNotice({ unsaved: true, editable: false, message: frameCopy("en").accessNotGiven, name: "intro.abc", language: "en" });
  assert.equal(denied?.text, "Access was not given. Nothing was changed. Ask again when you are ready.");
});

test("a gone file with edits has no frame button and says where saving writes", () => {
  const gone = failurePresentation(GONE, { unsaved: true, name: "intro.abc", language: "en" });
  assert.equal(gone.action, "none");
  assert.match(gone.body, /intro\.abc is gone/);
  assert.match(gone.body, /Your changes are still here/);
  assert.match(gone.body, /put it back where it was/);
  assert.doesNotMatch(gone.body, /deleted|moved/i);
  const zh = failurePresentation(GONE, { unsaved: true, name: "intro.abc", language: "zh" });
  assert.match(zh.body, /intro\.abc 不在了/);
  assert.match(zh.body, /你的修改还在/);
});

test("a deleted file without edits offers closing the window", () => {
  const gone = failurePresentation(GONE, { unsaved: false, name: "intro.abc", language: "en" });
  assert.equal(gone.action, "close");
});

test("Try again is never offered while edits are unsaved", () => {
  const failed = failurePresentation(FAILED, { unsaved: true, name: "intro.abc", language: "en" });
  assert.equal(failed.action, "none");
  assert.match(failed.body, /Your changes are still here/);
  assert.match(failed.body, /Save again when you can/);
});

test("lost access with edits names the cause and the next step", () => {
  const revoked = failurePresentation(REVOKED, { unsaved: true, name: "intro.abc", language: "en" });
  assert.equal(revoked.action, "access");
  assert.match(revoked.body, /Access to intro\.abc was removed/);
  assert.match(revoked.body, /save again/i);
  assert.match(revoked.body, /Ask for access/);
});

test("the access, back and view-only lines are in both languages", () => {
  const copy = frameCopy("en");
  assert.equal(copy.accessBack, "Access is back. Save again to keep your changes.");
  assert.match(copy.viewOnlyEdits, /Space’s owner/);
  assert.match(copy.backWithChanges, /\{name\} is back/);
  assert.equal(frameCopy("zh").accessBack, "权限已恢复。再保存一次，保住你的修改。");
});

test("a root file's folder line says Space root", () => {
  assert.equal(folderLine("intro.abc", "en"), "Space root");
  assert.equal(folderLine("intro.abc", "zh"), "Space 根目录");
  assert.equal(folderLine("scores/intro.abc", "en"), "scores");
});

test("the handoff line names the score editor window", () => {
  const en = frameCopy("en").handoffReady;
  assert.match(en, /score editor window/);
  assert.match(en, /switch windows/);
  assert.doesNotMatch(en, /this window/);
  const zh = frameCopy("zh").handoffReady;
  assert.match(zh, /乐谱编辑器窗口/);
  assert.match(zh, /切到别的窗口/);
  assert.doesNotMatch(zh, /这个窗口/);
});

test("the startup title reads as the review asked", () => {
  assert.equal(frameCopy("en").startupFailedTitle, "Couldn’t connect to Cohub");
});

test("a view-only grant with edits explains who must grant edit access", () => {
  const notice = editorNotice({ unsaved: true, editable: false, message: null, name: "intro.abc", language: "en" });
  assert.ok(notice);
  assert.match(notice.text, /You can view intro\.abc but not change it/);
  assert.equal(notice.action, "edit");
});

test("only a dirty score file needs the guard on the way home", () => {
  assert.equal(leaveNeedsGuard("generated", true), false);
  assert.equal(leaveNeedsGuard("scoreFile", false), false);
  assert.equal(leaveNeedsGuard("scoreFile", true), true);
});

test("a gone file names the file in the body, not the template", () => {
  const shown = failurePresentation(
    { status: "file-gone" },
    { unsaved: false, name: "intro.abc", language: "en" },
  );
  assert.match(shown.body, /intro\.abc/);
  assert.equal(shown.body.includes("{name}"), false);
});

test("a zh handoff check names the line without the parser's English text", () => {
  const text = handoffNoticeText(
    { kind: "check", problem: { code: "bad-line", params: {}, at: { line: 3 } } as never },
    "zh",
  );
  const zh = frameCopy("zh");
  assert.equal(
    text,
    fillCopy(zh.handoffBlocked, { reason: fillCopy(zh.handoffLine, { line: "3" }) }),
  );
  assert.equal(/score/i.test(text), false);

  const noLine = handoffNoticeText(
    { kind: "check", problem: { code: "bad-line", params: {}, at: {} } as never },
    "zh",
  );
  assert.equal(noLine, zh.handoffUnreadable);
});

test("a not-handled handoff says where the score is and that the chip stayed here", () => {
  const text = handoffNoticeText(
    { kind: "elsewhere", spaceName: "Mine", path: "scores/intro.abc" },
    "en",
  );
  assert.match(text, /Saved in Mine/);
  assert.match(text, /chip is still in this window/);
  assert.match(text, /open Mine/);
});

test("a handoff without a composer names the handoff file to read in both languages", () => {
  const path = "scores/intro.handoff.md";
  const same = handoffNoticeFor({ ok: true, path }, undefined, { composer: false });
  assert.deepEqual(same, { kind: "saved", path });
  assert.equal(
    same === null ? "" : handoffNoticeText(same, "en"),
    "Saved for the agent at scores/intro.handoff.md. In the chat, ask the agent to read that file and sing the score it names. Add anything else you want changed.",
  );
  assert.equal(
    same === null ? "" : handoffNoticeText(same, "zh"),
    "已为 agent 存好：scores/intro.handoff.md。在聊天里让 agent 读这个文件，按里面的谱重新生成，想改的别的地方一起说。",
  );

  const elsewhere = handoffNoticeFor(
    { ok: true, path, navigation: "handled" },
    { spaceName: "Mine" },
    { composer: false },
  );
  assert.deepEqual(elsewhere, { kind: "saved-elsewhere", spaceName: "Mine", path });
  assert.equal(
    elsewhere === null ? "" : handoffNoticeText(elsewhere, "en"),
    "Saved for the agent in Mine at scores/intro.handoff.md. Open Mine, and in its chat ask the agent to read that file and sing the score it names.",
  );
  assert.equal(
    elsewhere === null ? "" : handoffNoticeText(elsewhere, "zh"),
    "已为 agent 存到 Mine：scores/intro.handoff.md。打开 Mine，在它的聊天里让 agent 读这个文件，按里面的谱重新生成。",
  );
});

test("a replacement token in a file name is not expanded", () => {
  assert.equal(fillCopy("{name} is gone.", { name: "a$&b.abc" }), "a$&b.abc is gone.");
});
