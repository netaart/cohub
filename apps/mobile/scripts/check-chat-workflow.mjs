import assert from "node:assert/strict";
import { mock } from "node:test";
import { latestUnreadAssistantIndex } from "../src/data/chat-read-state.ts";
import { MessageMeasurements, createStreamBatch } from "../src/data/chat-rendering.ts";
import { invertedListDistances, nextChatTailFollowing, reverseListIndex } from "../src/data/chat-scroll.ts";
import { formatMessageClock } from "../src/data/chat-format.ts";
import { getComposerActionState } from "../src/data/composer-state.ts";
import { getComposerLayout } from "../src/ui/composer-layout.ts";
import { getComposerMenuLayout } from "../src/ui/composer-menu-layout.ts";
import { getResourcePinState, invalidateResourcePinReads, isResourcePinned, toggleResourcePin } from "../src/data/resource-pins.ts";
import { hasFinalAssistantForTurn, liveStreamStatusFromPatch, shouldShowLiveStream, streamRecoveryFromTail } from "../src/data/chat-stream.ts";
import { isWebSessionSource, sessionSourceGroup, toUserSessionLabels } from "../src/data/session-labels.ts";
import { chatThreadPlaceholder, mergeDisplayMessages, messageIndexForTurn, messagesFromTurns, nextTurnSequence, withFallbackUserContent, withTurnSequences } from "../src/data/session-history.ts";
import { compactionFromMessage, compactionStats } from "../src/data/compaction.ts";
import { mapRemoteSearchResults, normalizeSearchQuery } from "../src/data/session-search.ts";
import { filterSpaces } from "../src/data/space-filters.ts";
import { getSessionStatus, latestTurn, loadSessionLatestTurns, reconcileLatestTurn, reconcileTurnStatusPatch } from "../src/data/session-status.ts";
import { followupPreviewText, queuedFollowupTurns } from "../src/data/followup-queue.ts";
import { classifySaveConflict, isEditableTextFile, isFileConflictError } from "../src/data/code-file.ts";
import { detectCodeLanguage, resolveCodeLanguage } from "../src/data/code-language.ts";
import { markdownBlockSignature, parseInlineMarkdown, parseMarkdown } from "../src/data/markdown.ts";
import { splitStreamingMarkdown } from "../src/data/stream-markdown.ts";
import { StreamRevealController } from "../src/data/stream-reveal.ts";
import { connectionDisplayState, createSessionResyncCoordinator, isTransportRecovery } from "../src/data/session-reconnect.ts";
import { panelForScrollOffset } from "../src/data/space-panel-pager.ts";
import { getSpaceSessionCount, loadSpaceSessionCounts, publishSpaceSessionCount } from "../src/data/space-session-counts.ts";
import { cacheRetentionCutoff, DEFAULT_CACHE_RETENTION } from "../src/data/cache-retention.ts";
import { formatToolCallCaption, toolCallPreview } from "../src/data/tool-call.ts";
import { forkSessionTurn } from "../src/data/session-fork.ts";
import { resolveMessageLink } from "../src/data/message-links.ts";
import { validateAndroidUpdateAsset, verifyAndroidUpdateIntegrity } from "../src/data/update-assets.ts";

const forkCalls = [];
const forkClient = {
  space: (spaceId) => ({
    session: (sessionId) => ({
      turn: (turnId) => ({
        fork: async () => {
          forkCalls.push({ spaceId, sessionId, turnId });
          return { session: { id: "forked-session" }, fork: {} };
        },
      }),
    }),
  }),
};
const forkedSession = await forkSessionTurn(forkClient, "space-1", "session-1", { id: "child-turn", sourceTurnId: "source-turn" });
assert.equal(forkedSession.id, "forked-session");
assert.deepEqual(forkCalls, [{ spaceId: "space-1", sessionId: "session-1", turnId: "source-turn" }]);
await assert.rejects(() => forkSessionTurn(forkClient, "", "session-1", { id: "turn-1", sourceTurnId: null }), /Cannot fork/);

const measurements = new MessageMeasurements();
const measuredRows = [{ id: "a", revision: "1" }, { id: "b", revision: "1" }];
measurements.configure("360:1:light", measuredRows);
measurements.measure(measuredRows[0], 200);
assert.equal(measurements.estimateOffset(measuredRows, 2, 80), 280);
const revisedRows = [{ id: "a", revision: "2" }, measuredRows[1]];
assert.equal(measurements.estimateOffset(revisedRows, 2, 80), 160);
measurements.configure("720:1:light", measuredRows);
assert.equal(measurements.estimateOffset(measuredRows, 2, 80), 160);
measurements.measure(measuredRows[0], 200);
measurements.configure("720:1:light", []);
assert.equal(measurements.estimateOffset(measuredRows, 1, 80), 80);
assert.throws(() => measurements.measure(measuredRows[0], NaN), /positive and finite/);

mock.timers.enable({ apis: ["setTimeout"] });
try {
  const published = [];
  const batch = createStreamBatch((value) => published.push(value));
  batch.push("first");
  batch.push("latest");
  mock.timers.tick(31);
  assert.deepEqual(published, []);
  mock.timers.tick(1);
  assert.deepEqual(published, ["latest"]);
  batch.push("before lifecycle");
  batch.flush();
  assert.deepEqual(published, ["latest", "before lifecycle"]);
  batch.push("stale after completion");
  batch.cancel();
  mock.timers.tick(100);
  assert.deepEqual(published, ["latest", "before lifecycle"]);
} finally {
  mock.timers.reset();
}

mock.timers.enable({ apis: ["setTimeout", "Date"] });
const revealed = new StreamRevealController();
const revealedValues = [];
revealed.subscribe(() => revealedValues.push(revealed.getDisplayed()));
try {
  // First content is authoritative and shows whole instead of animating from empty.
  revealed.setTarget("你好");
  assert.deepEqual(revealedValues, ["你好"]);
  assert.ok(revealed.getFadeTailCount() > 0, "first content fades in");
  mock.timers.tick(200);
  assert.equal(revealed.getFadeTailCount(), 0, "fade window closes");
  // A ZWJ emoji arrives as one grapheme; a multi-grapheme append paces in commits.
  revealed.setTarget("你好👩🏽‍💻");
  mock.timers.tick(50);
  assert.equal(revealed.getDisplayed(), "你好👩🏽‍💻");
  revealed.setTarget("你好👩🏽‍💻abcdefghij");
  const beforePacing = revealedValues.length;
  mock.timers.tick(50);
  assert.ok(revealedValues.length > beforePacing, "appends commit over multiple frames");
  assert.ok(revealed.getFadeTailCount() > 0, "revealed graphemes are inside the fade window");
  mock.timers.tick(50);
  assert.ok(revealedValues.length > beforePacing + 1, "a long append takes more than one commit");
  for (const value of revealedValues) assert.ok(revealed.getDisplayed().startsWith(value), `revealed value is a prefix: ${value}`);
  mock.timers.tick(600);
  assert.equal(revealed.getDisplayed(), "你好👩🏽‍💻abcdefghij");
  // Never split the emoji across commits.
  for (const value of revealedValues) assert.ok(!value.endsWith("\u200d") && !/[\u{1F3FB}-\u{1F3FF}]$/u.test(value), `commit splits a grapheme: ${value}`);
  // An append that extends the trailing grapheme completes that unit first.
  revealed.setTarget("a");
  revealed.setTarget("a\u{1F3FD}");
  mock.timers.tick(600);
  assert.equal(revealed.getDisplayed(), "a\u{1F3FD}");
  // A correction is authoritative; it must not replay the obsolete suffix.
  revealed.setTarget("corrected");
  assert.equal(revealed.getDisplayed(), "corrected");
  // Completion drains immediately.
  revealed.setTarget("corrected answer");
  revealed.flush();
  assert.equal(revealed.getDisplayed(), "corrected answer");
  mock.timers.tick(500);
  assert.equal(revealedValues.at(-1), "corrected answer");
} finally {
  revealed.stop();
  mock.timers.reset();
}

// Streaming markdown: only the tail re-parses, so the split must stay stable
// across appends and must never cut a fence or a loose list in half.
assert.deepEqual(splitStreamingMarkdown("one"), { stable: "", tail: "one" });
assert.deepEqual(splitStreamingMarkdown("a\n\nb"), { stable: "a\n\n", tail: "b" });
assert.deepEqual(splitStreamingMarkdown("a\n\nb\n\nc"), { stable: "a\n\nb\n\n", tail: "c" });
assert.deepEqual(splitStreamingMarkdown("```\ncode\n\nmore\n```\n\nafter"), { stable: "```\ncode\n\nmore\n```\n\n", tail: "after" });
assert.deepEqual(splitStreamingMarkdown("- a\n\n- b\n\nc"), { stable: "- a\n\n- b\n\n", tail: "c" });
const firstSplit = splitStreamingMarkdown("a\n\nb");
assert.deepEqual(splitStreamingMarkdown("a\n\nb\n\nc", firstSplit), { stable: "a\n\nb\n\n", tail: "c" });
assert.deepEqual(splitStreamingMarkdown("a\n\nbc", firstSplit), { stable: "a\n\n", tail: "bc" });

const finalReply = { id: "final", role: "assistant", sequence: 2, meta: { turnId: "turn-1" }, text: "Final reply" };
const intermediateReply = { id: "step", role: "assistant", sequence: 1, meta: { turnId: "turn-1", messageKind: "assistant_intermediate" }, text: "Working" };
assert.deepEqual(mergeDisplayMessages([finalReply], [intermediateReply]), [finalReply]);
assert.deepEqual(mergeDisplayMessages([], [intermediateReply, finalReply]), [finalReply]);
const optimisticUser = { id: "local-1", role: "user", sequence: 1, meta: { optimistic: true, clientMessageId: "c1", turnSequence: 1 }, text: "hi" };
const confirmedUser = { id: "t1:user", role: "user", sequence: 1, meta: { turnId: "t1", turnSequence: 1, clientMessageId: "c1" }, text: "hi" };
assert.deepEqual(mergeDisplayMessages([confirmedUser], [optimisticUser]).map((message) => message.id), ["t1:user"]);
assert.equal(nextTurnSequence([{ sequence: 4 }], [{ meta: { turnSequence: 4 } }]), 5);
assert.equal(withTurnSequences([{ id: "u", role: "user", sequence: 19, meta: { turnId: "t10" }, text: "hi" }], [{ id: "t10", sequence: 10 }])[0]?.meta?.turnSequence, 10);
assert.equal(mergeDisplayMessages(
  [{ id: "t10:user", role: "user", sequence: 19, meta: { turnId: "t10", turnSequence: 10 }, text: "hi" }],
  [{ id: "live-user", role: "user", sequence: 19, meta: { turnId: "t10", clientMessageId: "c1" }, text: "hi" }],
)[0]?.meta?.turnSequence, 10);
const turnWithoutImage = { id: "t1", sessionId: "s1", sequence: 1, userContent: [{ type: "text", text: "photo" }], userText: "photo" };
const imageContent = [{ type: "image", source: { type: "url", url: "file://shot.jpg" } }];
assert.equal(withFallbackUserContent(turnWithoutImage, imageContent, "photo").userContent, imageContent);
assert.equal(withFallbackUserContent({ ...turnWithoutImage, userContent: imageContent }, [{ type: "text", text: "photo" }], "photo").userContent, imageContent);
assert.equal(chatThreadPlaceholder({ messageCount: 0, historyLoaded: false }), "opening");
assert.equal(chatThreadPlaceholder({ messageCount: 0, historyLoaded: false, error: "Unable to open Chat" }), null);
assert.equal(chatThreadPlaceholder({ messageCount: 0, historyLoaded: true }), "empty");
assert.equal(chatThreadPlaceholder({ messageCount: 2, historyLoaded: false }), null);

// Compaction ("context") turns project to a message whose text is the summary,
// not an empty assistant reply; the notice reads its stats from the turn meta.
const compactTurn = {
  id: "compact-turn",
  sessionId: "s1",
  sequence: 3,
  status: "completed",
  intent: "compact",
  userContent: [],
  userText: null,
  assistantContent: [{ type: "system_note", note_type: "compacted", text: "Earlier context summary" }],
  assistantText: null,
  provider: "deepseek",
  model: "deepseek-flash",
  stopReason: null,
  errorMessage: null,
  finalUsage: { input: 372_700, output: 1_200, cacheRead: 372_000 },
  totalUsage: null,
  meta: { compaction: { summarizedMessageCount: 12, tokensBefore: 372_700, estimatedTokensAfter: 44_000 } },
  userUuid: null,
  authorProfile: null,
  startedAt: null,
  completedAt: null,
  durationMs: 8_200,
  createdAt: "2026-09-10T09:12:00.000Z",
};
const compactMessages = messagesFromTurns([compactTurn]);
assert.equal(compactMessages.length, 1, "Compaction turns must project to exactly one message");
assert.equal(compactMessages[0]?.text, "Earlier context summary");
const compactInfo = compactionFromMessage(compactMessages[0]);
assert.equal(compactInfo?.summary, "Earlier context summary");
assert.equal(compactInfo?.meta.summarizedMessageCount, 12);
assert.deepEqual(compactionStats(compactInfo?.meta ?? {}), { summarizedMessageCount: 12, tokensBefore: 372_700, tokensAfter: 44_000 });
assert.equal(compactionFromMessage({ content: [{ type: "text", text: "hello" }], meta: {} }), null, "Regular messages are not compaction");
assert.equal(compactionFromMessage({ content: [], meta: { messageKind: "compacted" } })?.summary, "", "Compacted system messages still render a notice");
assert.equal(chatThreadPlaceholder({ messageCount: 0, historyLoaded: false, hasLiveActivity: true }), null);
assert.equal(liveStreamStatusFromPatch("idle"), null);
assert.equal(liveStreamStatusFromPatch("completed"), null);
assert.equal(liveStreamStatusFromPatch("pending"), "pending");
assert.equal(liveStreamStatusFromPatch("streaming"), "streaming");
assert.equal(hasFinalAssistantForTurn([finalReply], "turn-1"), true);
assert.equal(hasFinalAssistantForTurn([intermediateReply], "turn-1"), false);
const liveStream = { status: "streaming", contentBlocks: [{ type: "thinking", thinking: "working" }], intermediateMessages: [], turnId: "turn-1", messageId: null, runtimePhase: null, runtimeProvider: null, runtimeModel: null };
assert.equal(shouldShowLiveStream(liveStream, [finalReply]), false);
assert.equal(shouldShowLiveStream(liveStream, []), true);
assert.equal(shouldShowLiveStream({ ...liveStream, status: "pending" }, [finalReply]), false);

// Stream overlay vs. authoritative tail after a reconnect/foreground gap.
const runningTail = [{ id: "turn-2", sequence: 2, status: "running" }];
const finishedTail = [{ id: "turn-2", sequence: 2, status: "completed" }];
const twoTurns = [{ id: "turn-1", sequence: 1, status: "completed" }, { id: "turn-2", sequence: 2, status: "completed" }];
assert.equal(streamRecoveryFromTail({ stream: { turnId: "turn-2" }, tail: finishedTail[0], turns: finishedTail, messages: [] }), "clear");
assert.equal(streamRecoveryFromTail({ stream: { turnId: "turn-1" }, tail: twoTurns[1], turns: twoTurns, messages: [] }), "clear");
assert.equal(streamRecoveryFromTail({ stream: { turnId: null }, tail: finishedTail[0], turns: finishedTail, messages: [] }), "clear");
assert.equal(streamRecoveryFromTail({ stream: { turnId: "turn-2" }, tail: runningTail[0], turns: runningTail, messages: [] }), null);
assert.equal(streamRecoveryFromTail({ stream: null, tail: runningTail[0], turns: runningTail, messages: [] }), "pending");
assert.equal(streamRecoveryFromTail({ stream: null, tail: runningTail[0], turns: runningTail, messages: [{ ...finalReply, meta: { turnId: "turn-2" } }] }), null);
assert.equal(streamRecoveryFromTail({ stream: null, tail: null, turns: [], messages: [] }), null);
// An overlay already tracking a turn newer than the fetched tail must survive.
assert.equal(streamRecoveryFromTail({ stream: { turnId: "turn-3" }, tail: twoTurns[1], turns: twoTurns, messages: [] }), null);

const runningTurn = { id: "t9", sequence: 9, status: "running", updatedAt: "2026-09-01T00:00:00.000Z" };
const completedTurn = { ...runningTurn, status: "completed", updatedAt: "2026-09-01T00:01:00.000Z" };
assert.equal(latestTurn([{ sequence: 3, status: "completed" }, runningTurn, { sequence: 4, status: "failed" }]), runningTurn);
assert.equal(latestTurn([runningTurn, { ...completedTurn, sequence: 10 }])?.status, "completed");
assert.equal(latestTurn([]), null);
assert.equal(getSessionStatus(runningTurn.status), "running");
for (const status of ["in_progress", "pending", "queued", "abort_requested", "needs_input", "waiting", "completed", "failed", "interrupted", "merged", "cancelled", null, undefined]) {
  assert.notEqual(getSessionStatus(status), "running");
}
assert.equal(reconcileLatestTurn(completedTurn, runningTurn), completedTurn);
assert.equal(reconcileLatestTurn(completedTurn, { ...runningTurn, updatedAt: completedTurn.updatedAt }), completedTurn);
assert.equal(reconcileLatestTurn(completedTurn, { ...runningTurn, sequence: 8, updatedAt: "2026-09-02T00:00:00.000Z" }), completedTurn);
assert.equal(reconcileLatestTurn(completedTurn, { ...runningTurn, sequence: 10 })?.status, "running");
assert.equal(reconcileLatestTurn(undefined, null), null);
assert.equal(reconcileLatestTurn(completedTurn, null), completedTurn);
assert.deepEqual(reconcileTurnStatusPatch(runningTurn, { id: "t9", status: "completed", updatedAt: completedTurn.updatedAt }), completedTurn);
assert.equal(reconcileTurnStatusPatch(completedTurn, { id: "t8", status: "running" }), completedTurn);
assert.deepEqual(reconcileTurnStatusPatch(null, runningTurn), runningTurn);

mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
try {
  const recentStatusCalls = [];
  const recentStatusResults = [];
  const recentStatusClient = { space: () => ({ session: (id) => ({ turns: { listPaginated: async () => {
    recentStatusCalls.push(id);
    return { turns: [runningTurn] };
  } } }) }) };
  const sessions = [
    { id: "recent", spaceId: "space1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-09-08T11:59:00.000Z" },
    { id: "boundary", spaceId: "space1", updatedAt: "2026-09-08T11:30:00.000Z" },
    { id: "old", spaceId: "space1", status: "running", updatedAt: "2026-09-08T11:29:59.999Z" },
  ];
  await loadSessionLatestTurns(recentStatusClient, sessions, (id) => recentStatusResults.push(id));
  assert.deepEqual(recentStatusCalls, ["recent", "boundary"]);
  assert.deepEqual(recentStatusResults, ["recent", "boundary"]);
  recentStatusCalls.length = 0;
  await loadSessionLatestTurns(recentStatusClient, [sessions[2]], () => assert.fail("Old sessions must not publish a status"));
  assert.deepEqual(recentStatusCalls, []);
  await assert.rejects(loadSessionLatestTurns(recentStatusClient, [{ id: "invalid", spaceId: "space1", updatedAt: "not-a-date" }], () => assert.fail("Invalid activity dates must not publish a status")), /Invalid updatedAt for Chat invalid/);
  assert.deepEqual(recentStatusCalls, []);
  mock.timers.tick(31 * 60 * 1000);
  await loadSessionLatestTurns(recentStatusClient, sessions, () => assert.fail("The recent window must advance on every refresh"));
  assert.deepEqual(recentStatusCalls, []);
} finally {
  mock.timers.reset();
}

const statusCalls = [];
const statusResults = new Map();
const recentSession = { spaceId: "space1", updatedAt: new Date().toISOString() };
const statusClient = { space: (spaceId) => ({ session: (sessionId) => ({ turns: { listPaginated: async (options) => {
  statusCalls.push({ spaceId, sessionId, options });
  return { turns: sessionId === "empty" ? [] : [runningTurn] };
} } }) }) };
await loadSessionLatestTurns(statusClient, [{ ...recentSession, id: "s1", status: "idle" }, { ...recentSession, id: "empty", status: "running" }], (id, turn) => statusResults.set(id, turn));
assert.equal(statusResults.get("s1")?.status, "running");
assert.equal(statusResults.get("empty"), null);
assert.deepEqual(statusCalls[0], { spaceId: "space1", sessionId: "s1", options: { limit: 1, direction: "older" } });

let inFlightStatuses = 0;
let maxInFlightStatuses = 0;
let completedStatuses = 0;
await loadSessionLatestTurns({ space: () => ({ session: () => ({ turns: { listPaginated: async () => {
  inFlightStatuses += 1;
  maxInFlightStatuses = Math.max(maxInFlightStatuses, inFlightStatuses);
  await new Promise((resolve) => setTimeout(resolve, 0));
  inFlightStatuses -= 1;
  return { turns: [runningTurn] };
} } }) }) }, Array.from({ length: 15 }, (_, id) => ({ ...recentSession, id: String(id) })), () => { completedStatuses += 1; });
assert.equal(maxInFlightStatuses, 6);
assert.equal(completedStatuses, 15);
const failedStatusResults = [];
await assert.rejects(loadSessionLatestTurns({ space: () => ({ session: (id) => ({ turns: { listPaginated: async () => {
  if (id === "failed") throw new Error("Network unavailable");
  return { turns: [runningTurn] };
} } }) }) }, [{ ...recentSession, id: "failed", status: "running" }, { ...recentSession, id: "ok" }], (id) => failedStatusResults.push(id)), /Could not refresh 1 Chat status/);
assert.deepEqual(failedStatusResults, ["ok"]);

let resolveOldStatus;
let reconciledStatus = runningTurn;
const staleStatusRequest = loadSessionLatestTurns({ space: () => ({ session: () => ({ turns: { listPaginated: () => new Promise((resolve) => { resolveOldStatus = resolve; }) } }) }) }, [{ ...recentSession, id: "s1" }], (_id, turn) => { reconciledStatus = reconcileLatestTurn(reconciledStatus, turn); });
reconciledStatus = reconcileTurnStatusPatch(reconciledStatus, completedTurn);
resolveOldStatus({ turns: [runningTurn] });
await staleStatusRequest;
assert.equal(reconciledStatus.status, "completed");
mock.timers.enable({ apis: ["setTimeout"] });
try {
  const timedOutStatuses = loadSessionLatestTurns({ space: () => ({ session: () => ({ turns: { listPaginated: () => new Promise(() => {}) } }) }) }, [{ ...recentSession, id: "s1" }], () => assert.fail("A timeout must not publish a status"));
  const rejection = assert.rejects(timedOutStatuses, /Could not refresh 1 Chat status/);
  mock.timers.tick(15_000);
  await rejection;
} finally {
  mock.timers.reset();
}
assert.equal(isTransportRecovery("reconnecting", "open"), true);
assert.equal(isTransportRecovery("closed", "open"), true);
assert.equal(isTransportRecovery("error", "open"), true);
assert.equal(isTransportRecovery("idle", "open"), false);
assert.equal(isTransportRecovery("connecting", "open"), false);
assert.equal(isTransportRecovery("open", "open"), false);
assert.equal(isTransportRecovery("open", "reconnecting"), false);
// A recoverable realtime error keeps the socket open: never show it as an outage.
assert.equal(connectionDisplayState({ state: "error", recoverable: true }), null);
assert.equal(connectionDisplayState({ state: "error", recoverable: false }), "error");
assert.equal(connectionDisplayState({ state: "closed", willReconnect: true }), "reconnecting");
assert.equal(connectionDisplayState({ state: "closed", willReconnect: false }), "closed");
assert.equal(connectionDisplayState({ state: "open" }), "open");
assert.equal(connectionDisplayState({ state: "connecting" }), "connecting");
assert.equal(connectionDisplayState({ state: "reconnecting" }), "reconnecting");

mock.timers.enable({ apis: ["setTimeout"] });
try {
  const resyncRuns = [];
  const resyncResolvers = [];
  const resync = createSessionResyncCoordinator({
    debounceMs: 250,
    run: (sessionId, reason) => new Promise((resolve) => {
      resyncRuns.push({ sessionId, reason });
    resyncResolvers.push(resolve);
    }),
  });
  // `open` and `active` firing back-to-back collapse into one run with the latest reason.
  resync.request("s1", "transport-open");
  resync.request("s1", "foreground");
  mock.timers.tick(249);
  assert.deepEqual(resyncRuns, []);
  mock.timers.tick(1);
  assert.deepEqual(resyncRuns, [{ sessionId: "s1", reason: "foreground" }]);
  // A trigger during an in-flight resync queues exactly one follow-up.
  resync.request("s1", "out-of-sync");
  resync.request("s1", "transport-open");
  mock.timers.tick(250);
  assert.equal(resyncRuns.length, 1);
  resyncResolvers.shift()();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(resyncRuns.at(-1), { sessionId: "s1", reason: "transport-open" });
  assert.equal(resyncRuns.length, 2);
  // Other sessions are independent.
  resync.request("s2", "foreground");
  mock.timers.tick(250);
  assert.equal(resyncRuns.length, 3);
  // Cancel drops a pending trigger; a rejected run must not break later runs.
  resync.request("s3", "foreground");
  resync.cancel("s3");
  mock.timers.tick(250);
  assert.equal(resyncRuns.filter((run) => run.sessionId === "s3").length, 0);
  const failing = createSessionResyncCoordinator({ debounceMs: 0, run: async () => { throw new Error("boom"); } });
  failing.request("s4", "foreground");
  mock.timers.tick(0);
  await Promise.resolve();
  await Promise.resolve();
  failing.request("s4", "foreground");
  mock.timers.tick(0);
  // Disposal cancels pending triggers and ignores new ones.
  resync.request("s5", "foreground");
  resync.dispose();
  resync.request("s6", "foreground");
  mock.timers.tick(250);
  assert.equal(resyncRuns.filter((run) => run.sessionId === "s5" || run.sessionId === "s6").length, 0);
  for (const resolve of resyncResolvers) resolve();
} finally {
  mock.timers.reset();
}

mock.timers.enable({ apis: ["setTimeout"] });
try {
  const flush = async () => { for (let index = 0; index < 4; index += 1) await Promise.resolve(); };
  let clock = 1_000;
  const gatedRuns = [];
  const gated = createSessionResyncCoordinator({
    debounceMs: 0,
    cooldowns: { "out-of-sync": 15_000 },
    now: () => clock,
    run: async (sessionId, reason) => { gatedRuns.push({ sessionId, reason }); },
  });
  assert.equal(gated.request("s7", "out-of-sync"), true);
  mock.timers.tick(0);
  await flush();
  assert.deepEqual(gatedRuns, [{ sessionId: "s7", reason: "out-of-sync" }]);
  // Repeated drift inside the window is suppressed so a broken server cannot loop snapshots.
  assert.equal(gated.request("s7", "out-of-sync"), false);
  mock.timers.tick(0);
  await flush();
  assert.equal(gatedRuns.length, 1);
  // The window is per session.
  assert.equal(gated.request("s8", "out-of-sync"), true);
  mock.timers.tick(0);
  await flush();
  assert.equal(gatedRuns.length, 2);
  // Reconnect recovery is never throttled, even right after a re-seed.
  assert.equal(gated.request("s7", "transport-open"), true);
  mock.timers.tick(0);
  await flush();
  assert.deepEqual(gatedRuns.at(-1), { sessionId: "s7", reason: "transport-open" });
  // Once the window elapses another drift re-seed is allowed.
  clock += 15_000;
  assert.equal(gated.request("s7", "out-of-sync"), true);
  mock.timers.tick(0);
  await flush();
  assert.deepEqual(gatedRuns.at(-1), { sessionId: "s7", reason: "out-of-sync" });
  // Closing the Chat clears the window so reopening can re-seed immediately.
  gated.request("s7", "out-of-sync");
  gated.cancel("s7");
  assert.equal(gated.request("s7", "out-of-sync"), true);
  mock.timers.tick(0);
  await flush();
  assert.equal(gatedRuns.filter((run) => run.sessionId === "s7" && run.reason === "out-of-sync").length, 3);
  gated.dispose();
} finally {
  mock.timers.reset();
}

assert.equal(isWebSessionSource({ source: "web" }), true);
assert.equal(isWebSessionSource({ source: "web_app" }), true);
assert.equal(isWebSessionSource({ source: null }), true);
assert.equal(isWebSessionSource({ source: "mobile" }), true);
assert.equal(sessionSourceGroup({ source: "mobile" }), "web");
assert.equal(sessionSourceGroup({ source: "Web App" }), "web");
assert.deepEqual(toUserSessionLabels([
  { id: "src", name: "Source", source: "system", systemKey: null, children: [{ id: "web", name: "Web App", source: "system", systemKey: "session-source:web", children: [] }] },
  { id: "work", name: "Work", source: "user", systemKey: null, children: [{ id: "urgent", name: "Urgent", source: "user", systemKey: null, children: [] }] },
]).map((label) => label.ref), ["Work/Urgent", "Work"]);
assert.equal(normalizeSearchQuery("  server   result  "), "server result");
assert.equal(isResourcePinned([{ labelSystemKey: "user:pinned" }]), true);
assert.equal(isResourcePinned([{ labelSystemKey: "other" }]), false);
assert.deepEqual(filterSpaces([{ id: "a", isPinned: true }, { id: "b", isPinned: false }, { id: "c", isPinned: true }], "pinned").map((space) => space.id), ["a", "c"]);
assert.deepEqual(filterSpaces([
  { id: "old", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "new", updatedAt: "2026-09-01T00:00:00.000Z" },
], "recent").map((space) => space.id), ["new", "old"]);
assert.equal(panelForScrollOffset(0, 360, 760), "chat");
assert.equal(panelForScrollOffset(360, 360, 760), null);
assert.equal(panelForScrollOffset(760, 360, 760), "files");
assert.equal(panelForScrollOffset(150, 360, 760), "chat");
assert.equal(panelForScrollOffset(620, 360, 760), "files");

// Space Chat counts come from a cached probe of the Space's first page.
const countListCalls = [];
let countInFlight = 0;
let countMaxInFlight = 0;
const countClient = {
  space: (spaceId) => ({
    sessions: {
      list: async ({ limit } = {}) => {
        countListCalls.push({ spaceId, limit });
        countInFlight += 1;
        countMaxInFlight = Math.max(countMaxInFlight, countInFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        countInFlight -= 1;
        const total = spaceId === "small" ? 3 : 25;
        const count = Math.min(total, limit ?? 20);
        return {
          sessions: Array.from({ length: count }, (_, index) => ({ id: `${spaceId}-${index}` })),
          pageInfo: { hasMore: total > count, nextCursor: null },
        };
      },
    },
  }),
};
await loadSpaceSessionCounts(countClient, Array.from({ length: 9 }, (_, index) => `space-${index}`));
assert.ok(countMaxInFlight <= 4, "Space count probes must stay within the concurrency cap");
await loadSpaceSessionCounts(countClient, ["small", "big"]);
assert.deepEqual(getSpaceSessionCount(countClient, "small"), { count: 3, hasMore: false });
assert.deepEqual(getSpaceSessionCount(countClient, "big"), { count: 20, hasMore: true });
const countCallsAfterProbe = countListCalls.length;
await loadSpaceSessionCounts(countClient, ["small", "big"]);
assert.equal(countListCalls.length, countCallsAfterProbe, "Fresh Space counts must be reused");
await loadSpaceSessionCounts(countClient, ["small"], { force: true });
assert.equal(countListCalls.length, countCallsAfterProbe + 1);
publishSpaceSessionCount(countClient, "published", 7, false);
assert.deepEqual(getSpaceSessionCount(countClient, "published"), { count: 7, hasMore: false });
const failingCountClient = { space: () => ({ sessions: { list: async () => { throw new Error("offline"); } } }) };
await loadSpaceSessionCounts(failingCountClient, ["broken"]);
assert.equal(getSpaceSessionCount(failingCountClient, "broken"), null, "Failed probes must not be cached");
const sharedProbes = [];
const shareCountClient = {
  space: (spaceId) => ({
    sessions: {
      list: async () => {
        sharedProbes.push(spaceId);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { sessions: [{ id: "shared-session" }], pageInfo: { hasMore: false, nextCursor: null } };
      },
    },
  }),
};
await Promise.all([
  loadSpaceSessionCounts(shareCountClient, ["shared"]),
  loadSpaceSessionCounts(shareCountClient, ["shared"]),
]);
assert.equal(sharedProbes.length, 1, "Concurrent probes for the same Space must be shared");
assert.deepEqual(getSpaceSessionCount(shareCountClient, "shared"), { count: 1, hasMore: false });

// Cache retention prunes by cache write time; the default window is one week.
assert.equal(DEFAULT_CACHE_RETENTION, "7d");
const retentionNow = Date.UTC(2026, 0, 10);
assert.equal(cacheRetentionCutoff("1d", retentionNow), retentionNow - 24 * 60 * 60 * 1000);
assert.equal(cacheRetentionCutoff("7d", retentionNow), retentionNow - 7 * 24 * 60 * 60 * 1000);
assert.equal(cacheRetentionCutoff("30d", retentionNow), retentionNow - 30 * 24 * 60 * 60 * 1000);
assert.equal(cacheRetentionCutoff("forever", retentionNow), null);

let fakePinned = false;
const pinCalls = [];
const fakeClient = {
  user: {
    labels: {
      getResourceLabels: async () => ({ assignments: fakePinned ? [{ labelSystemKey: "user:pinned" }] : [] }),
      patchResourceLabels: async (_resourceType, _resourceRef, input) => {
        pinCalls.push(input);
        fakePinned = Boolean(input.addLabelRefs);
        return { assignments: fakePinned ? [{ labelSystemKey: "user:pinned" }] : [] };
      },
    },
  },
};
assert.equal(await getResourcePinState(fakeClient, "session", "session-1", { force: true }), false);
assert.equal(await toggleResourcePin(fakeClient, "session", "session-1", false), true);
assert.deepEqual(pinCalls, [{ addLabelRefs: ["Pinned"] }]);

let resolveRaceRead;
let racePinned = false;
const raceRead = new Promise((resolve) => {
  resolveRaceRead = resolve;
});
const raceClient = {
  user: {
    labels: {
      getResourceLabels: async () => raceRead,
      patchResourceLabels: async (_resourceType, _resourceRef, input) => {
        racePinned = Boolean(input.addLabelRefs);
        return { assignments: racePinned ? [{ labelSystemKey: "user:pinned" }] : [] };
      },
    },
  },
};
const staleRead = getResourcePinState(raceClient, "session", "race-1", { force: true });
const raceMutation = toggleResourcePin(raceClient, "session", "race-1", false);
resolveRaceRead({ assignments: [] });
assert.equal(await staleRead, false);
assert.equal(await raceMutation, true);
assert.equal(await getResourcePinState(raceClient, "session", "race-1"), true);

let patchStarted = false;
let resolveFirstPatch;
const mutationClient = {
  user: {
    labels: {
      getResourceLabels: async () => ({ assignments: [] }),
      patchResourceLabels: async (_resourceType, _resourceRef, input) => {
        patchStarted = true;
        await new Promise((resolve) => { resolveFirstPatch = resolve; });
        return { assignments: input.addLabelRefs ? [{ labelSystemKey: "user:pinned" }] : [] };
      },
    },
  },
};
const mutation = toggleResourcePin(mutationClient, "session", "mutation-1", false);
while (!patchStarted) await new Promise((resolve) => setTimeout(resolve, 0));
let readDuringMutationResolved = false;
const readDuringMutation = getResourcePinState(mutationClient, "session", "mutation-1", { force: true }).then((value) => {
  readDuringMutationResolved = true;
  return value;
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(readDuringMutationResolved, false);
resolveFirstPatch(true);
assert.equal(await mutation, true);
assert.equal(await readDuringMutation, true);

let invalidationReadCount = 0;
let resolveHangingRead;
const invalidationClient = {
  user: {
    labels: {
      getResourceLabels: async () => {
        invalidationReadCount += 1;
        if (invalidationReadCount === 1) return { assignments: [{ labelSystemKey: "user:pinned" }] };
        if (invalidationReadCount === 2) return new Promise((resolve) => { resolveHangingRead = resolve; });
        return { assignments: [] };
      },
    },
  },
};
assert.equal(await getResourcePinState(invalidationClient, "session", "retry-1"), true);
const hangingRead = getResourcePinState(invalidationClient, "session", "retry-1", { force: true });
await new Promise((resolve) => setTimeout(resolve, 0));
invalidateResourcePinReads(invalidationClient, "session", ["retry-1"]);
assert.equal(await getResourcePinState(invalidationClient, "session", "retry-1"), false);
resolveHangingRead({ assignments: [{ labelSystemKey: "user:pinned" }] });
assert.equal(await hangingRead, true);
assert.equal(invalidationReadCount, 3);

const searchResult = (overrides = {}) => ({
  type: "turn",
  id: "turn-1",
  spaceId: "space-1",
  sessionId: "session-1",
  turnId: "turn-1",
  sequence: 7,
  title: "Matched prompt",
  excerpt: "A server-side match",
  spaceName: "Research",
  sessionTitle: "A remote Chat",
  spaceProfile: null,
  matchedField: "userText",
  href: "/spaces/space-1/sessions/session-1?turn=7",
  score: 0.4,
  textScore: 0.9,
  recencyScore: 0.2,
  typePriorityScore: 0.2,
  updatedAt: "2026-09-01T00:00:00.000Z",
  source: "remote",
  ...overrides,
});

assert.deepEqual(
  getComposerActionState({ text: "follow up", hasAttachment: false, disabled: false, sending: false, running: true, hasStopHandler: true }),
  { blocked: false, hasDraft: true, canSend: true, canStop: false },
);
assert.deepEqual(
  getComposerActionState({ text: "", hasAttachment: false, disabled: false, sending: false, running: true, hasStopHandler: true }),
  { blocked: false, hasDraft: false, canSend: false, canStop: true },
);
assert.deepEqual(
  getComposerActionState({ text: "", hasAttachment: true, disabled: false, sending: false, running: true, hasStopHandler: true }),
  { blocked: false, hasDraft: true, canSend: true, canStop: false },
);
assert.deepEqual(
  getComposerActionState({ text: "follow up", hasAttachment: false, disabled: false, sending: true, running: true, hasStopHandler: true }),
  { blocked: true, hasDraft: true, canSend: false, canStop: false },
);
const composerLayoutInput = { text: "hello", contentHeight: 30, lineHeight: 22, availableHeight: 800, expanded: false };
assert.deepEqual(getComposerLayout({ ...composerLayoutInput, text: "" }), {
  expanded: false, showExpandButton: false, height: 44, scrollEnabled: false,
});
assert.deepEqual(getComposerLayout(composerLayoutInput), {
  expanded: false, showExpandButton: false, height: 44, scrollEnabled: false,
});
assert.equal(getComposerLayout({ ...composerLayoutInput, text: "hello\n" }).showExpandButton, true, "explicit newline is expandable before native measurement");
assert.deepEqual(getComposerLayout({ ...composerLayoutInput, contentHeight: 52 }), {
  expanded: false, showExpandButton: true, height: 52, scrollEnabled: false,
}, "soft-wrapped text grows and exposes expansion");
assert.deepEqual(getComposerLayout({ ...composerLayoutInput, contentHeight: 600 }), {
  expanded: false, showExpandButton: true, height: 120, scrollEnabled: true,
});
assert.deepEqual(getComposerLayout({ ...composerLayoutInput, contentHeight: 600, expanded: true }), {
  expanded: true, showExpandButton: true, height: 320, scrollEnabled: true,
});
assert.deepEqual(getComposerLayout({ ...composerLayoutInput, contentHeight: 52, expanded: true }), {
  expanded: true, showExpandButton: true, height: 320, scrollEnabled: false,
});
assert.equal(getComposerLayout({ ...composerLayoutInput, expanded: true }).showExpandButton, true, "collapse remains available after deleting back to one line");
assert.deepEqual(getComposerLayout({ ...composerLayoutInput, text: "", contentHeight: 600, expanded: true }), {
  expanded: false, showExpandButton: false, height: 44, scrollEnabled: false,
}, "clearing or sending resets the layout even before the native measurement catches up");
assert.equal(getComposerLayout({ ...composerLayoutInput, availableHeight: 400, expanded: true }).height, 180, "expanded input leaves room above the keyboard");
assert.equal(getComposerLayout({ ...composerLayoutInput, availableHeight: 180, contentHeight: 600 }).height, 81, "short viewports also constrain the default input");
assert.equal(getComposerLayout({ ...composerLayoutInput, lineHeight: 44, contentHeight: 52 }).showExpandButton, false, "a large-font single line is not mistaken for multiline");
assert.equal(getComposerLayout({ ...composerLayoutInput, lineHeight: 44, contentHeight: 96 }).showExpandButton, true);
assert.equal(getComposerLayout({ ...composerLayoutInput, lineHeight: 44, contentHeight: 52 }).height, 52);
const composerMenuInput = { anchor: { x: 12, y: 680, width: 366, height: 114 }, windowWidth: 390, windowHeight: 844, topInset: 47, bottomInset: 34, keyboardTop: null, preferredWidth: 360 };
assert.deepEqual(getComposerMenuLayout(composerMenuInput), { left: 12, bottom: 172, width: 360, maxHeight: 480 });
assert.equal(getComposerMenuLayout({ ...composerMenuInput, preferredWidth: 240 }).width, 240, "attachments use a compact menu");
assert.equal(getComposerMenuLayout({ ...composerMenuInput, windowWidth: 320 }).width, 296, "menu fits narrow screens");
assert.equal(getComposerMenuLayout({ ...composerMenuInput, anchor: { ...composerMenuInput.anchor, x: 300 } }).left, 18, "menu stays inside the right edge");
const iosKeyboardMenu = getComposerMenuLayout({ ...composerMenuInput, keyboardTop: 500, bottomInset: 0 });
assert.deepEqual(iosKeyboardMenu, { left: 12, bottom: 352, width: 360, maxHeight: 433 }, "iOS menu clears the keyboard without resizing the modal window");
const androidKeyboardMenu = getComposerMenuLayout({ ...composerMenuInput, windowHeight: 500, keyboardTop: 500, bottomInset: 0 });
assert.deepEqual(androidKeyboardMenu, { left: 12, bottom: 12, width: 360, maxHeight: 429 }, "Android uses the resized modal height without double-subtracting the keyboard");
const tallDraftMenu = getComposerMenuLayout({ ...composerMenuInput, anchor: { ...composerMenuInput.anchor, y: 280 }, windowHeight: 400, keyboardTop: 400, bottomInset: 0 });
assert.equal(tallDraftMenu.maxHeight, 213, "a tall draft constrains the menu above it");
assert.ok(400 - tallDraftMenu.bottom - tallDraftMenu.maxHeight >= composerMenuInput.topInset + 12);
assert.equal(nextChatTailFollowing({ currentlyFollowing: true, distanceToBottom: 420, userInteracting: false, pendingTarget: false }), true);
assert.equal(nextChatTailFollowing({ currentlyFollowing: false, distanceToBottom: 420, userInteracting: false, pendingTarget: false }), false);
assert.equal(nextChatTailFollowing({ currentlyFollowing: true, distanceToBottom: 420, userInteracting: true, pendingTarget: false }), false);
assert.equal(nextChatTailFollowing({ currentlyFollowing: false, distanceToBottom: 20, userInteracting: true, pendingTarget: false }), true);
assert.equal(nextChatTailFollowing({ currentlyFollowing: true, distanceToBottom: 20, userInteracting: false, pendingTarget: true }), false);
assert.equal(nextChatTailFollowing({ currentlyFollowing: false, distanceToBottom: 20, userInteracting: false, pendingTarget: true }), false);
assert.equal(reverseListIndex(0, 10), 9);
assert.equal(reverseListIndex(9, 10), 0);
assert.equal(reverseListIndex(-1, 10), -1);
assert.deepEqual(invertedListDistances(0, 4000, 700), { distanceToLatest: 0, distanceToOldest: 3300 });
assert.deepEqual(invertedListDistances(3280, 4000, 700), { distanceToLatest: 3280, distanceToOldest: 20 });

const messages = [
  { role: "assistant", meta: { turnSequence: 6 } },
  { role: "user", meta: { turnSequence: 7 } },
  { role: "assistant", meta: { turnSequence: 7 } },
  { role: "user", meta: { turnSequence: 8 } },
];
assert.equal(messageIndexForTurn(messages, 7), 1);
assert.equal(messageIndexForTurn(messages, 8), 3);
assert.equal(messageIndexForTurn([{ role: "assistant", meta: { turnSequence: 9 } }], 9), 0);
assert.equal(messageIndexForTurn(messages, 99), -1);
assert.equal(latestUnreadAssistantIndex(messages, null), 2);
assert.equal(latestUnreadAssistantIndex(messages, 6), 2);
assert.equal(latestUnreadAssistantIndex(messages, 7), -1);
assert.equal(latestUnreadAssistantIndex([{ role: "assistant", sequence: 1, meta: null }], null), -1);

const mapped = mapRemoteSearchResults([
  searchResult({ type: "session", id: "session-1", turnId: null, sequence: null, score: 0.99, title: "Remote Chat" }),
  searchResult({ type: "turn", score: 0.4, sequence: 7, turnId: "turn-7" }),
]);
assert.equal(mapped.sessions.length, 1);
assert.equal(mapped.sessions[0]?.sessionId, "session-1");
assert.equal(mapped.sessions[0]?.turnSequence, 7);
assert.equal(mapped.sessions[0]?.turnId, "turn-7");

assert.equal(toolCallPreview("skill_view", { skill: "github-pr-workflow" }), "github-pr-workflow");
assert.equal(toolCallPreview("terminal", { command: "git status --short --branch && git rebase" }), "git status --short --branch && git rebase");
assert.equal(toolCallPreview("bash", { command: { preview: "git pull --rebase origin main" } }), "git pull --rebase origin main");
assert.equal(toolCallPreview("read", { path: "src/app.ts" }), "src/app.ts");
assert.equal(toolCallPreview("unknown", {}), "");
assert.equal(formatToolCallCaption("skill_view", { skill: "github-pr-workflow" }), "skill_view: \"github-pr-workflow\"");
assert.equal(formatToolCallCaption("terminal", {}), "terminal");
assert.equal(formatMessageClock(new Date(2026, 0, 1, 19, 3).toISOString()), "19:03");
assert.equal(formatMessageClock("not-a-date"), "");

const apkRelease = {
  version: "1.6.1",
  downloadUrl: "https://github.com/markbang/cohub-mobile/releases/download/v1.6.1/cohub-v1.6.1-android-arm64-v8a.apk",
  downloadName: "cohub-v1.6.1-android-arm64-v8a.apk",
  downloadSize: 123,
  downloadSha256: "A".repeat(64),
};
for (const abi of ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]) {
  const name = `cohub-v1.6.1-android-${abi}.apk`;
  const url = `https://github.com/markbang/cohub-mobile/releases/download/v1.6.1/${name}`;
  assert.deepEqual(validateAndroidUpdateAsset({ ...apkRelease, downloadName: name, downloadUrl: url }), {
    name, url, size: 123, sha256: "a".repeat(64),
  });
}
for (const invalid of [
  { version: "1.6.1-beta" },
  { downloadUrl: "https://github.com/other/repo/releases/download/v1.6.1/update.apk" },
  { downloadUrl: apkRelease.downloadUrl.replace("https:", "http:") },
  { downloadUrl: `${apkRelease.downloadUrl}?redirect=elsewhere` },
  { downloadName: "../update.apk" },
  { downloadName: "cohub-v1.6.0-android-arm64-v8a.apk" },
  { downloadSize: 0 },
  { downloadSize: NaN },
  { downloadSize: 1.5 },
  { downloadSha256: null },
  { downloadSha256: "invalid" },
]) assert.throws(() => validateAndroidUpdateAsset({ ...apkRelease, ...invalid }));
const apkAsset = validateAndroidUpdateAsset(apkRelease);
assert.doesNotThrow(() => verifyAndroidUpdateIntegrity(apkAsset, { size: 123, sha256: "a".repeat(64) }));
assert.throws(() => verifyAndroidUpdateIntegrity(apkAsset, { size: 124, sha256: apkAsset.sha256 }), /verification/);
assert.throws(() => verifyAndroidUpdateIntegrity(apkAsset, { size: 123, sha256: "b".repeat(64) }), /verification/);

const queuedFollowup = (id, sequence, overrides = {}) => ({ id, sequence, status: "queued", intent: "followup", userText: `Follow-up ${id}`, createdAt: "2026-09-01T00:00:00.000Z", ...overrides });
assert.deepEqual(
  queuedFollowupTurns([
    { id: "running", sequence: 2, status: "running", intent: "followup", userText: "now", createdAt: "2026-09-01T00:00:00.000Z" },
    queuedFollowup("b", 4),
    queuedFollowup("a", 3),
    queuedFollowup("steer", 5, { intent: "steer" }),
    queuedFollowup("done", 6, { status: "cancelled" }),
  ], "running").map((turn) => turn.id),
  ["a", "b"],
);
assert.deepEqual(queuedFollowupTurns([queuedFollowup("active", 7)], "active"), []);
// A stale queued record after the previous turn completed is not a live queue: nothing is running to steer.
assert.deepEqual(queuedFollowupTurns([
  { id: "finished", sequence: 8, status: "completed", intent: "followup", userText: "done", createdAt: "2026-09-01T00:00:00.000Z" },
  queuedFollowup("stale", 9),
], null), []);
assert.deepEqual(queuedFollowupTurns([
  { id: "running", sequence: 10, status: "running", intent: "followup", userText: "now", createdAt: "2026-09-01T00:00:00.000Z" },
  queuedFollowup("next", 11),
], null).map((turn) => turn.id), ["next"]);
assert.equal(followupPreviewText({ userText: "  hello\n\n world  " }), "hello world");
assert.equal(followupPreviewText({ userText: "   " }), "Follow-up");
assert.equal(followupPreviewText({ userText: null }), "Follow-up");

const tableBlocks = parseMarkdown("| Name | Value |\n| :--- | ---: |\n| a | `1` |\n| b | 2 |\n\ntail");
assert.deepEqual(tableBlocks[0], {
  type: "table",
  alignments: ["left", "right"],
  header: [[{ type: "text", value: "Name" }], [{ type: "text", value: "Value" }]],
  rows: [
    [[{ type: "text", value: "a" }], [{ type: "code", value: "1" }]],
    [[{ type: "text", value: "b" }], [{ type: "text", value: "2" }]],
  ],
});
assert.deepEqual(tableBlocks[1], { type: "paragraph", inlines: [{ type: "text", value: "tail" }] });
const unclosedCode = parseMarkdown("before\n```ts\nconst x = 1");
assert.deepEqual(unclosedCode[1], { type: "code", language: "ts", code: "const x = 1", closed: false });
assert.deepEqual(parseMarkdown("```ts\nconst x = 1\n```")[0], { type: "code", language: "ts", code: "const x = 1", closed: true });
assert.deepEqual(parseInlineMarkdown("a **b** _c_ `d` [e](https://f)"), [
  { type: "text", value: "a " },
  { type: "strong", value: "b" },
  { type: "text", value: " " },
  { type: "emphasis", value: "c" },
  { type: "text", value: " " },
  { type: "code", value: "d" },
  { type: "text", value: " " },
  { type: "link", url: "https://f", value: "e" },
]);
// Message-specific link families: Space/Skill mentions, image syntax pointing at sandbox paths, cohub:// links.
assert.deepEqual(parseInlineMarkdown("@[design-skill](cohub://spaces/241ec263-bd4f-47d6-b459-35b4219e0c23) help"), [
  { type: "mention", url: "cohub://spaces/241ec263-bd4f-47d6-b459-35b4219e0c23", value: "design-skill" },
  { type: "text", value: " help" },
]);
assert.deepEqual(parseInlineMarkdown("see ![Contact Sheet](/workspace/out/sheet.png) now"), [
  { type: "text", value: "see " },
  { type: "image", url: "/workspace/out/sheet.png", value: "Contact Sheet" },
  { type: "text", value: " now" },
]);
assert.deepEqual(parseInlineMarkdown("[open](cohub://spaces/241ec263-bd4f-47d6-b459-35b4219e0c23/sessions/81816f3f-02fa-4b71-b775-ba64a5759c8f)"), [
  { type: "link", url: "cohub://spaces/241ec263-bd4f-47d6-b459-35b4219e0c23/sessions/81816f3f-02fa-4b71-b775-ba64a5759c8f", value: "open" },
]);
// A bare `[x](y)` with an unsupported scheme stays text, and a later valid link on the same line is still found.
assert.deepEqual(parseInlineMarkdown("[a](ftp://x) [b](https://y)"), [
  { type: "text", value: "[a](ftp://x) " },
  { type: "link", url: "https://y", value: "b" },
]);

assert.deepEqual(resolveMessageLink("cohub://spaces/241ec263-bd4f-47d6-b459-35b4219e0c23"), { kind: "space", spaceId: "241ec263-bd4f-47d6-b459-35b4219e0c23" });
assert.deepEqual(resolveMessageLink("cohub://spaces/241ec263-bd4f-47d6-b459-35b4219e0c23/sessions/81816f3f-02fa-4b71-b775-ba64a5759c8f"), { kind: "session", spaceId: "241ec263-bd4f-47d6-b459-35b4219e0c23", sessionId: "81816f3f-02fa-4b71-b775-ba64a5759c8f" });
assert.deepEqual(resolveMessageLink("https://cohub.live/spaces/241ec263-bd4f-47d6-b459-35b4219e0c23/sessions/81816f3f-02fa-4b71-b775-ba64a5759c8f?turn=3"), { kind: "session", spaceId: "241ec263-bd4f-47d6-b459-35b4219e0c23", sessionId: "81816f3f-02fa-4b71-b775-ba64a5759c8f" });
assert.deepEqual(resolveMessageLink("/workspace/avatars/out/contact-sheet.png"), { kind: "file", path: "/workspace/avatars/out/contact-sheet.png" });
assert.deepEqual(resolveMessageLink("https://example.com/x"), { kind: "external", url: "https://example.com/x" });
assert.equal(resolveMessageLink("javascript:alert(1)"), null);
assert.equal(resolveMessageLink(""), null);

const stableBlocks = parseMarkdown("one\n\ntwo");
const grownBlocks = parseMarkdown("one\n\ntwo and more");
assert.equal(markdownBlockSignature(stableBlocks[0]), markdownBlockSignature(grownBlocks[0]));
assert.notEqual(markdownBlockSignature(stableBlocks[1]), markdownBlockSignature(grownBlocks[1]));

assert.equal(detectCodeLanguage("src/components/App.tsx"), "tsx");
assert.equal(detectCodeLanguage("docs/readme.md"), "markdown");
assert.equal(detectCodeLanguage("Dockerfile"), "dockerfile");
assert.equal(detectCodeLanguage("Makefile"), null);
assert.equal(resolveCodeLanguage("ts"), "typescript");
assert.equal(resolveCodeLanguage("C++"), "cpp");
assert.equal(resolveCodeLanguage("unknown"), null);

const textFile = { path: "a.ts", name: "a.ts", size: 10, mimeType: "text/plain", mtimeMs: 1, kind: "text", encoding: "utf-8", content: "const a" };
assert.equal(isEditableTextFile(textFile), true);
assert.equal(isEditableTextFile({ ...textFile, delivery: "url" }), false);
assert.equal(isEditableTextFile({ ...textFile, encoding: "base64" }), false);
assert.equal(isEditableTextFile({ ...textFile, kind: "binary" }), false);
assert.equal(isEditableTextFile({ ...textFile, size: 512 * 1024 + 1 }), false);
assert.equal(classifySaveConflict({ ...textFile, content: "draft" }, "base", "draft"), "already-saved");
assert.equal(classifySaveConflict({ ...textFile, content: "base" }, "base", "draft"), "retry");
assert.equal(classifySaveConflict({ ...textFile, content: "other" }, "base", "draft"), "conflict");
assert.equal(classifySaveConflict(null, "base", "draft"), "conflict");
assert.equal(isFileConflictError({ status: 409 }), true);
assert.equal(isFileConflictError({ code: "file_conflict" }), true);
assert.equal(isFileConflictError(new Error("nope")), false);

console.log("Chat workflow checks passed");
