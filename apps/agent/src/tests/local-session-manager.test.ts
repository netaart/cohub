import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../runtime/local-session-manager.js";

function firstMessageText(manager: SessionManager): string | undefined {
  const message = manager.buildSessionContext().messages[0] as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;
  return message?.content?.find((part) => part.type === "text")?.text;
}

const root = await mkdtemp(join(tmpdir(), "cohub-local-session-manager-"));
try {
  const sessionsDir = join(root, "sessions");
  const sessionFile = join(sessionsDir, "session.jsonl");
  const manager = SessionManager.create(root, sessionsDir);
  manager.newSession({ id: "session" });
  manager.setSessionFile(sessionFile);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: Date.now(),
    meta: { messageId: "user-message-1" },
  } as never);

  assert.equal(manager.hasUserMessage("user-message-1"), true);
  assert.equal(manager.hasUserMessage("missing"), false);

  await manager.flush();
  const content = await readFile(sessionFile, "utf-8");
  assert.equal(content.trim().split("\n").length, 2);

  const reopened = await SessionManager.open(sessionFile, sessionsDir);
  assert.equal(reopened.hasUserMessage("user-message-1"), true);
  assert.equal(reopened.buildSessionContext().messages.length, 1);
  assert.deepEqual(reopened.getSessionAffinity(), { sessionId: "session", threadId: "session" });

  const childSessionFile = join(sessionsDir, "child.jsonl");
  await reopened.createBranchedSession(reopened.getBranchEntries().at(-1)?.id ?? "", {
    id: "child",
    filePath: childSessionFile,
  });
  const child = await SessionManager.open(childSessionFile, sessionsDir);
  assert.deepEqual(child.getSessionAffinity(), { sessionId: "session", threadId: "child" });

  const grandchildSessionFile = join(sessionsDir, "grandchild.jsonl");
  await child.createBranchedSession(child.getBranchEntries().at(-1)?.id ?? "", {
    id: "grandchild",
    filePath: grandchildSessionFile,
  });
  const grandchild = await SessionManager.open(grandchildSessionFile, sessionsDir);
  assert.deepEqual(grandchild.getSessionAffinity(), { sessionId: "session", threadId: "grandchild" });

  const unicodeSeparatorText = "before emoji \u{1f680}\u2028between\u2029after";
  const legacySeparatorFile = join(sessionsDir, "legacy-unicode-separators.jsonl");
  const legacySeparatorContent = [
    JSON.stringify({ type: "session", version: 3, id: "legacy-separators", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: "message", id: "legacy", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: unicodeSeparatorText }], timestamp: Date.now() } }),
    JSON.stringify({ type: "message", id: "after-legacy", parentId: "legacy", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "still valid" }], timestamp: Date.now() } }),
    "",
  ].join("\n");
  assert.equal(legacySeparatorContent.includes("\u2028"), true);
  assert.equal(legacySeparatorContent.includes("\u2029"), true);
  await writeFile(legacySeparatorFile, legacySeparatorContent);
  const legacySeparators = await SessionManager.open(legacySeparatorFile, sessionsDir, { recoverTrailingPartial: true });
  assert.equal(legacySeparators.getEntries().length, 2);
  assert.equal(firstMessageText(legacySeparators), unicodeSeparatorText);

  const chunkBoundaryFile = join(sessionsDir, "chunk-boundary-unicode-separators.jsonl");
  const chunkBoundaryText = `${"x".repeat(70_000)}\u2028chunk-boundary\u2029end`;
  await writeFile(chunkBoundaryFile, [
    JSON.stringify({ type: "session", version: 3, id: "chunk-boundary", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: "message", id: "chunk-boundary-entry", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: chunkBoundaryText }], timestamp: Date.now() } }),
    "",
  ].join("\r\n"));
  const chunkBoundary = await SessionManager.open(chunkBoundaryFile, sessionsDir);
  assert.equal(firstMessageText(chunkBoundary), chunkBoundaryText);

  const appendSeparatorFile = join(sessionsDir, "append-unicode-separators.jsonl");
  const appendSeparators = SessionManager.create(root, sessionsDir);
  appendSeparators.newSession({ id: "append-separators" });
  appendSeparators.setSessionFile(appendSeparatorFile);
  await appendSeparators.flush();
  appendSeparators.appendMessage({
    role: "user",
    content: [{ type: "text", text: unicodeSeparatorText }],
    timestamp: Date.now(),
  } as never);
  await appendSeparators.close();
  const appendSeparatorContent = await readFile(appendSeparatorFile, "utf-8");
  assert.equal(appendSeparatorContent.includes("\u2028"), false);
  assert.equal(appendSeparatorContent.includes("\u2029"), false);
  assert.equal(appendSeparatorContent.includes("\\u2028"), true);
  assert.equal(appendSeparatorContent.includes("\\u2029"), true);
  assert.equal(firstMessageText(await SessionManager.open(appendSeparatorFile, sessionsDir)), unicodeSeparatorText);

  const rewriteSeparatorFile = join(sessionsDir, "rewrite-unicode-separators.jsonl");
  const rewriteSeparators = SessionManager.create(root, sessionsDir);
  rewriteSeparators.newSession({ id: "rewrite-separators" });
  rewriteSeparators.appendMessage({
    role: "user",
    content: [{ type: "text", text: unicodeSeparatorText }],
    timestamp: Date.now(),
  } as never);
  rewriteSeparators.setSessionFile(rewriteSeparatorFile);
  await rewriteSeparators.close();
  const rewriteSeparatorContent = await readFile(rewriteSeparatorFile, "utf-8");
  assert.equal(rewriteSeparatorContent.includes("\u2028"), false);
  assert.equal(rewriteSeparatorContent.includes("\u2029"), false);
  assert.equal(firstMessageText(await SessionManager.open(rewriteSeparatorFile, sessionsDir)), unicodeSeparatorText);

  const separatorBranchFile = join(sessionsDir, "branch-unicode-separators.jsonl");
  await rewriteSeparators.createBranchedSession(rewriteSeparators.getBranchEntries().at(-1)?.id ?? "", {
    id: "branch-separators",
    filePath: separatorBranchFile,
  });
  const separatorBranchContent = await readFile(separatorBranchFile, "utf-8");
  assert.equal(separatorBranchContent.includes("\u2028"), false);
  assert.equal(separatorBranchContent.includes("\u2029"), false);
  assert.equal(firstMessageText(await SessionManager.open(separatorBranchFile, sessionsDir)), unicodeSeparatorText);

  const branchedSessionFile = join(sessionsDir, "branched.jsonl");
  await writeFile(branchedSessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "branched", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: "message", id: "root", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "root" }], timestamp: Date.now(), meta: { messageId: "root-message" } } }),
    JSON.stringify({ type: "message", id: "side", parentId: "root", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "side" }], timestamp: Date.now(), meta: { messageId: "side-message" } } }),
    JSON.stringify({ type: "message", id: "main", parentId: "root", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "main" }], timestamp: Date.now() } }),
    "",
  ].join("\n"));

  const branched = await SessionManager.open(branchedSessionFile, sessionsDir);
  assert.deepEqual(branched.getSessionAffinity(), { sessionId: "branched", threadId: "branched" });
  assert.equal(branched.hasUserMessage("root-message"), true);
  assert.equal(branched.hasUserMessage("side-message"), false);

  const recoverableFile = join(sessionsDir, "recoverable.jsonl");
  const recoverableContent = [
    JSON.stringify({ type: "session", version: 3, id: "recoverable", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: "message", id: "valid", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "valid" }], timestamp: Date.now() } }),
    '{"type":"message"',
  ].join("\n");
  await writeFile(recoverableFile, recoverableContent);
  await assert.rejects(() => SessionManager.open(recoverableFile, sessionsDir), /Invalid session JSONL/);

  const recovered = await SessionManager.open(recoverableFile, sessionsDir, { recoverTrailingPartial: true });
  assert.equal(recovered.getEntries().length, 1);
  assert.equal((await readFile(recoverableFile, "utf-8")).endsWith("\n"), true);
  const recoveryArchives = await readdir(join(sessionsDir, "archives", "recovery"));
  assert.equal(recoveryArchives.length, 1);
  assert.equal(
    await readFile(join(sessionsDir, "archives", "recovery", recoveryArchives[0] as string), "utf-8"),
    recoverableContent,
  );

  const missingNewlineFile = join(sessionsDir, "missing-newline.jsonl");
  const missingNewlineContent = recoverableContent.slice(0, recoverableContent.lastIndexOf("\n"));
  await writeFile(missingNewlineFile, missingNewlineContent);
  await SessionManager.open(missingNewlineFile, sessionsDir, { recoverTrailingPartial: true });
  assert.equal(await readFile(missingNewlineFile, "utf-8"), `${missingNewlineContent}\n`);

  const noHeaderFile = join(sessionsDir, "no-header.jsonl");
  const noHeaderContent = `${JSON.stringify({ type: "message", id: "orphan" })}\n{"type":"message"`;
  await writeFile(noHeaderFile, noHeaderContent);
  await assert.rejects(
    () => SessionManager.open(noHeaderFile, sessionsDir, { recoverTrailingPartial: true }),
    /Invalid session JSONL/,
  );
  assert.equal(await readFile(noHeaderFile, "utf-8"), noHeaderContent);

  const terminatedBadFile = join(sessionsDir, "terminated-bad.jsonl");
  await writeFile(terminatedBadFile, `${recoverableContent.slice(0, recoverableContent.lastIndexOf("\n"))}\nnot-json\n`);
  await assert.rejects(
    () => SessionManager.open(terminatedBadFile, sessionsDir, { recoverTrailingPartial: true }),
    /Invalid session JSONL/,
  );

  // Regression: buildSessionContext must not duplicate kept messages when the
  // compaction entry is the root (post-rewrite layout, normal state after the
  // first compaction). A duplication here would double the whole request context.
  const postRewriteFile = join(sessionsDir, "post-rewrite.jsonl");
  const postRewriteEntry = (id: string, parentId: string | null, role: "user" | "assistant") => ({
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text: id }], timestamp: Date.now() },
  });
  await writeFile(postRewriteFile, [
    JSON.stringify({ type: "session", version: 3, id: "post-rewrite", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: "compaction", id: "c1", parentId: null, timestamp: new Date().toISOString(), summary: "s1", firstKeptEntryId: "k1", tokensBefore: 100 }),
    JSON.stringify(postRewriteEntry("k1", "c1", "user")),
    JSON.stringify(postRewriteEntry("k2", "k1", "assistant")),
    JSON.stringify(postRewriteEntry("k3", "k2", "user")),
    "",
  ].join("\n"));
  const postRewrite = await SessionManager.open(postRewriteFile, sessionsDir);
  const postRewriteMessages = postRewrite.buildSessionContext().messages;
  assert.equal(postRewriteMessages.length, 4, "post-rewrite layout must not duplicate kept messages");
  assert.equal(postRewriteMessages[0]?.role, "compactionSummary");
  assert.equal(postRewriteMessages[1]?.role, "user");
  assert.equal(postRewriteMessages[2]?.role, "assistant");
  assert.equal(postRewriteMessages[3]?.role, "user");

  // Pre-rewrite layout (compaction at end): entries from firstKeptEntryId up to
  // the compaction entry, plus entries appended after it.
  const preRewriteFile = join(sessionsDir, "pre-rewrite.jsonl");
  await writeFile(preRewriteFile, [
    JSON.stringify({ type: "session", version: 3, id: "pre-rewrite", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify(postRewriteEntry("old1", null, "user")),
    JSON.stringify(postRewriteEntry("old2", "old1", "assistant")),
    JSON.stringify(postRewriteEntry("keep1", "old2", "user")),
    JSON.stringify(postRewriteEntry("keep2", "keep1", "assistant")),
    JSON.stringify({ type: "compaction", id: "c2", parentId: "keep2", timestamp: new Date().toISOString(), summary: "s2", firstKeptEntryId: "keep1", tokensBefore: 100 }),
    JSON.stringify(postRewriteEntry("after1", "c2", "assistant")),
    "",
  ].join("\n"));
  const preRewrite = await SessionManager.open(preRewriteFile, sessionsDir);
  const preRewriteTexts = preRewrite.buildSessionContext().messages.map((message) => {
    const record = message as { role?: string; content?: Array<{ text?: string }> };
    return record.role === "compactionSummary" ? "summary" : record.content?.[0]?.text;
  });
  assert.deepEqual(preRewriteTexts, ["summary", "keep1", "keep2", "after1"]);

  // Pre-rewrite layout with firstKeptEntryId missing: include all pre-compaction
  // entries (fallback) plus post-compaction entries, without duplicates.
  const preRewriteMissingFile = join(sessionsDir, "pre-rewrite-missing.jsonl");
  await writeFile(preRewriteMissingFile, [
    JSON.stringify({ type: "session", version: 3, id: "pre-rewrite-missing", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify(postRewriteEntry("old1", null, "user")),
    JSON.stringify(postRewriteEntry("old2", "old1", "assistant")),
    JSON.stringify({ type: "compaction", id: "c3", parentId: "old2", timestamp: new Date().toISOString(), summary: "s3", firstKeptEntryId: "missing", tokensBefore: 100 }),
    JSON.stringify(postRewriteEntry("after1", "c3", "assistant")),
    "",
  ].join("\n"));
  const preRewriteMissing = await SessionManager.open(preRewriteMissingFile, sessionsDir);
  const preRewriteMissingTexts = preRewriteMissing.buildSessionContext().messages.map((message) => {
    const record = message as { role?: string; content?: Array<{ text?: string }> };
    return record.role === "compactionSummary" ? "summary" : record.content?.[0]?.text;
  });
  assert.deepEqual(preRewriteMissingTexts, ["summary", "old1", "old2", "after1"]);

  // Regression: multiple consecutive compaction cycles through the real
  // appendCompaction + archiveAndRewrite flow must never duplicate context.
  const multiCompactFile = join(sessionsDir, "multi-compact.jsonl");
  const multiCompact = SessionManager.create(root, sessionsDir);
  multiCompact.newSession({ id: "multi-compact" });
  multiCompact.setSessionFile(multiCompactFile);
  const msg = (text: string, role: "user" | "assistant") =>
    multiCompact.appendMessage({ role, content: [{ type: "text", text }], timestamp: Date.now() } as never);
  msg("m1", "user");
  msg("m2", "assistant");
  const cm3 = msg("m3", "user");
  msg("m4", "assistant");
  const cm5 = msg("m5", "user");
  msg("m6", "assistant");
  const compactContextTexts = () => multiCompact.buildSessionContext().messages.map((message) => {
    const record = message as { role?: string; content?: Array<{ text?: string }> };
    return record.role === "compactionSummary" ? "summary" : record.content?.[0]?.text;
  });
  const c1 = multiCompact.appendCompaction("s1", cm3, 100);
  await multiCompact.archiveAndRewrite(c1, cm3);
  assert.deepEqual(compactContextTexts(), ["summary", "m3", "m4", "m5", "m6"]);
  msg("m7", "user");
  const cm8 = msg("m8", "assistant");
  assert.deepEqual(compactContextTexts(), ["summary", "m3", "m4", "m5", "m6", "m7", "m8"]);
  const c2 = multiCompact.appendCompaction("s2", cm5, 100);
  await multiCompact.archiveAndRewrite(c2, cm5);
  assert.deepEqual(compactContextTexts(), ["summary", "m5", "m6", "m7", "m8"]);
  msg("m9", "user");
  const c3 = multiCompact.appendCompaction("s3", cm8, 100);
  await multiCompact.archiveAndRewrite(c3, cm8);
  assert.deepEqual(compactContextTexts(), ["summary", "m8", "m9"]);

  // Compaction must keep the latest thinking/model settings even when they
  // were recorded before firstKeptEntryId. Dropping them made the next cold
  // start treat thinking as off.
  const settingsCompactFile = join(sessionsDir, "settings-compact.jsonl");
  const settingsCompact = SessionManager.create(root, sessionsDir);
  settingsCompact.newSession({ id: "settings-compact" });
  settingsCompact.setSessionFile(settingsCompactFile);
  settingsCompact.appendModelChange("cohub", "claude-opus-5-5");
  settingsCompact.appendThinkingLevelChange("high");
  const settingsMsg = (text: string, role: "user" | "assistant") =>
    settingsCompact.appendMessage({ role, content: [{ type: "text", text }], timestamp: Date.now() } as never);
  settingsMsg("old-user", "user");
  settingsMsg("old-assistant", "assistant");
  const keptUser = settingsMsg("kept-user", "user");
  settingsMsg("kept-assistant", "assistant");
  assert.equal(settingsCompact.buildSessionContext().thinkingLevel, "high");
  assert.deepEqual(settingsCompact.buildSessionContext().model, { provider: "cohub", modelId: "claude-opus-5-5" });
  const settingsCompactId = settingsCompact.appendCompaction("summarized", keptUser, 100);
  await settingsCompact.archiveAndRewrite(settingsCompactId, keptUser);
  const compactedContext = settingsCompact.buildSessionContext();
  assert.equal(compactedContext.thinkingLevel, "high");
  assert.deepEqual(compactedContext.model, { provider: "cohub", modelId: "claude-opus-5-5" });
  assert.deepEqual(compactedContext.messages.map((message) => {
    const record = message as { role?: string; content?: Array<{ text?: string }> };
    return record.role === "compactionSummary" ? "summary" : record.content?.[0]?.text;
  }), ["summary", "kept-user", "kept-assistant"]);
  await settingsCompact.flush();
  const reopenedSettings = await SessionManager.open(settingsCompactFile, sessionsDir);
  assert.equal(reopenedSettings.buildSessionContext().thinkingLevel, "high");
  assert.deepEqual(reopenedSettings.buildSessionContext().model, { provider: "cohub", modelId: "claude-opus-5-5" });

  settingsCompact.appendThinkingLevelChange("low");
  const laterKept = settingsMsg("later-user", "user");
  const secondCompactId = settingsCompact.appendCompaction("summarized-again", laterKept, 50);
  await settingsCompact.archiveAndRewrite(secondCompactId, laterKept);
  assert.equal(settingsCompact.buildSessionContext().thinkingLevel, "low");

  const unrecorded = SessionManager.create(root, sessionsDir);
  unrecorded.newSession({ id: "unrecorded" });
  unrecorded.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as never);
  assert.equal(unrecorded.buildSessionContext().thinkingLevel, null);
} finally {
  await rm(root, { recursive: true, force: true });
}
