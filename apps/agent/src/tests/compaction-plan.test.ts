import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareCompaction, type CompactionSettings } from "@earendil-works/pi-agent-core";
import { SessionManager } from "../runtime/local-session-manager.js";
import {
  findFirstKeptEntryId,
  getCompactionSummaryMessageCount,
  resolveCompactionScope,
  validateCompactionEffect,
} from "../runtime/compaction-plan.js";

const root = await mkdtemp(join(tmpdir(), "cohub-compaction-plan-"));
const managers: SessionManager[] = [];
test.after(async () => {
  await Promise.all(managers.map((manager) => manager.flush()));
  await rm(root, { recursive: true, force: true });
});

function createSession(id: string) {
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.newSession({ id });
  manager.setSessionFile(join(root, "sessions", `${id}.jsonl`));
  managers.push(manager);
  return manager;
}

function appendUser(manager: SessionManager, text: string) {
  return manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as never);
}

function appendAssistant(manager: SessionManager, text: string, stopReason = "stop") {
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "test",
    model: "test",
    stopReason,
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp: Date.now(),
  } as never);
}

/** Plan the way maybeAutoCompact does: pi's plan over the projected branch, anchored to a session entry. */
function plan(manager: SessionManager, settings: CompactionSettings) {
  const entries = manager.getCompactionEntries();
  const prepared = prepareCompaction(entries, settings);
  if (!prepared.ok || !prepared.value) assert.fail("Expected compaction preparation");
  return { preparation: prepared.value, firstKeptEntryId: findFirstKeptEntryId(entries, prepared.value.retainedTail) };
}

const long = (label: string) => `${label} `.repeat(2_000);
const settings: CompactionSettings = { enabled: true, reserveTokens: 100, keepRecentTokens: 3_000 };

test("single-turn split compaction accepts a turn prefix without prior history", () => {
  const manager = createSession("split");
  appendUser(manager, "Keep working");
  appendAssistant(manager, "Earlier work ".repeat(2_000), "toolUse");
  const recent = appendAssistant(manager, "Recent work ".repeat(100));

  const { preparation, firstKeptEntryId } = plan(manager, { enabled: true, reserveTokens: 100, keepRecentTokens: 20 });
  assert.equal(preparation.isSplitTurn, true);
  assert.equal(preparation.messagesToSummarize.length, 0);
  assert.ok(preparation.turnPrefixMessages.length > 0);
  assert.ok(getCompactionSummaryMessageCount(preparation) > 0);
  assert.equal(firstKeptEntryId, recent);
});

test("settings and custom message entries do not break planning", () => {
  // Every real session file carries model/thinking settings; pi only knows
  // message/compaction/branch_summary/custom entries and used to throw on them.
  const manager = createSession("settings");
  manager.appendModelChange("cohub", "claude-opus-5-5");
  manager.appendThinkingLevelChange("high");
  manager.appendSessionInfo("title");
  manager.appendCustomMessageEntry("cohub.note", [{ type: "text", text: "custom context" }], false);
  appendUser(manager, long("old"));
  appendAssistant(manager, long("old-answer"));
  const kept = appendUser(manager, long("recent"));
  appendAssistant(manager, "done");

  const { preparation, firstKeptEntryId } = plan(manager, settings);
  assert.equal(firstKeptEntryId, kept);
  // The custom message is context: it is summarized, not silently dropped.
  assert.ok(preparation.messagesToSummarize.some((message) => JSON.stringify(message).includes("custom context")));
});

test("compacting a rewritten session keeps its retained entries", async () => {
  const manager = createSession("rewritten");
  manager.appendModelChange("cohub", "claude-opus-5-5");
  manager.appendThinkingLevelChange("high");
  appendUser(manager, long("first"));
  appendAssistant(manager, long("first-answer"));
  const firstKept = appendUser(manager, long("second"));
  appendAssistant(manager, long("second-answer"));
  const compactionId = manager.appendCompaction("first summary", firstKept, 100, { readFiles: ["a.ts"], modifiedFiles: [] });
  assert.ok(await manager.archiveAndRewrite(compactionId, firstKept));
  // Rewritten layout: compaction root, pinned settings, then the kept entries.
  assert.deepEqual(manager.getBranchEntries().slice(0, 3).map((entry) => entry.type), ["compaction", "model_change", "thinking_level_change"]);
  const nextKept = appendUser(manager, long("third"));
  appendAssistant(manager, "done");

  const { preparation, firstKeptEntryId } = plan(manager, settings);
  assert.equal(preparation.previousSummary, "first summary");
  assert.equal(firstKeptEntryId, nextKept);
  // Entries kept by the first compaction are summarized now, not lost.
  assert.ok(preparation.messagesToSummarize.some((message) => JSON.stringify(message).includes("second-answer")));
  assert.ok(preparation.fileOps.read.has("a.ts"));
});

test("a pre-rewrite layout keeps the range from firstKeptEntryId", () => {
  // Compaction appended after its kept range (files predating archiveAndRewrite).
  const manager = createSession("legacy");
  appendUser(manager, long("dropped"));
  const firstKept = appendUser(manager, long("kept-before"));
  manager.appendCompaction("legacy summary", firstKept, 100);
  appendAssistant(manager, long("after"));
  const recent = appendUser(manager, long("recent"));
  appendAssistant(manager, "done");

  const { preparation, firstKeptEntryId } = plan(manager, settings);
  const summarized = JSON.stringify(preparation.messagesToSummarize);
  assert.ok(summarized.includes("kept-before"));
  assert.ok(!summarized.includes("dropped"));
  assert.equal(firstKeptEntryId, recent);
});

test("compacting a pre-rewrite layout inside its kept range keeps only the new summary", async () => {
  // The projection puts the legacy kept range after its compaction, so the new
  // cut can land before the legacy compaction entry in the file.
  const manager = createSession("legacy-inside-kept");
  appendUser(manager, long("dropped"));
  const firstKept = appendUser(manager, long("kept-a"));
  appendAssistant(manager, long("kept-b"));
  appendUser(manager, "kept-c");
  manager.appendCompaction("legacy summary", firstKept, 100);
  appendAssistant(manager, "after");
  appendUser(manager, "recent");
  appendAssistant(manager, "done");

  const { preparation, firstKeptEntryId } = plan(manager, settings);
  assert.ok(firstKeptEntryId);
  assert.ok(getCompactionSummaryMessageCount(preparation) > 0);
  const legacyIdx = manager.getBranchEntries().findIndex((entry) => entry.type === "compaction");
  const cutIdx = manager.getBranchEntries().findIndex((entry) => entry.id === firstKeptEntryId);
  assert.ok(cutIdx < legacyIdx, "the cut lands before the legacy compaction");

  const compactionId = manager.appendCompaction("new summary", firstKeptEntryId, 100);
  assert.ok(await manager.archiveAndRewrite(compactionId, firstKeptEntryId));
  const compactions = manager.getBranchEntries().filter((entry) => entry.type === "compaction");
  assert.deepEqual(compactions.map((entry) => entry.id), [compactionId]);
  const [summary, ...rest] = manager.buildSessionContext().messages;
  assert.ok(summary?.role === "compactionSummary");
  assert.equal(summary.summary, "new summary");
  assert.ok(!JSON.stringify(rest).includes("kept-a"), "summarized entries leave the context");
  assert.ok(JSON.stringify(rest).includes("done"));
});

test("first kept entry is resolved by message identity", () => {
  const manager = createSession("identity");
  const user = appendUser(manager, "hello");
  const entries = manager.getCompactionEntries();
  const message = entries.find((entry) => entry.id === user);
  assert.ok(message?.type === "message");
  assert.equal(findFirstKeptEntryId(entries, [message.message]), user);
  // A structurally equal copy is not the same entry.
  assert.equal(findFirstKeptEntryId(entries, [structuredClone(message.message)]), undefined);
  assert.equal(findFirstKeptEntryId(entries, []), undefined);
});

test("split compaction belongs to the containing turn", () => {
  assert.deepEqual(resolveCompactionScope({ isSplitTurn: true }, "turn-1"), {
    scope: "within_turn",
    ownerTurnId: "turn-1",
  });
  assert.deepEqual(resolveCompactionScope({ isSplitTurn: false }, "turn-1"), {
    scope: "between_turns",
    ownerTurnId: null,
  });
});

test("compaction effect must reduce context and fit the next input budget", () => {
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 100,
    inputBudget: 90,
  }), "compaction_no_effect");
  // Threshold compactions need a meaningful reduction (>=20%); marginal
  // shrinks are rejected so image-dominated contexts don't re-compact on
  // every round without reducing the actual payload.
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 95,
    inputBudget: 90,
  }), "compaction_no_effect");
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 81,
    inputBudget: 90,
  }), "compaction_no_effect");
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 70,
    inputBudget: 90,
  }), null);
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 70,
    inputBudget: 60,
  }), "compaction_still_over_budget");
  // Overflow-recovery compactions only require any reduction at all.
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 95,
    inputBudget: 90,
    force: true,
  }), "compaction_still_over_budget");
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 100,
    inputBudget: 90,
    force: true,
  }), "compaction_no_effect");
});
