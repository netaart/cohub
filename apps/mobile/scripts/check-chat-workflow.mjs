import assert from "node:assert/strict";
import { mock } from "node:test";
import { latestUnreadAssistantIndex } from "../src/data/chat-read-state.ts";
import { MessageMeasurements, createStreamBatch } from "../src/data/chat-rendering.ts";
import { nextChatTailFollowing } from "../src/data/chat-scroll.ts";
import { formatMessageClock } from "../src/data/chat-format.ts";
import { getComposerActionState } from "../src/data/composer-state.ts";
import { getResourcePinState, invalidateResourcePinReads, isResourcePinned, toggleResourcePin } from "../src/data/resource-pins.ts";
import { mergeDisplayMessages, messageIndexForTurn } from "../src/data/session-history.ts";
import { mapRemoteSearchResults, normalizeSearchQuery } from "../src/data/session-search.ts";
import { filterSpaces } from "../src/data/space-filters.ts";
import { panelForOpeningDelta, shouldClosePanel, shouldOpenPanel } from "../src/data/space-panel-gesture.ts";
import { formatToolCallCaption, toolCallPreview } from "../src/data/tool-call.ts";
import { validateAndroidUpdateAsset, verifyAndroidUpdateIntegrity } from "../src/data/update-assets.ts";

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

const finalReply = { id: "final", role: "assistant", sequence: 2, meta: { turnId: "turn-1" }, text: "Final reply" };
const intermediateReply = { id: "step", role: "assistant", sequence: 1, meta: { turnId: "turn-1", messageKind: "assistant_intermediate" }, text: "Working" };
assert.deepEqual(mergeDisplayMessages([finalReply], [intermediateReply]), [finalReply]);
assert.deepEqual(mergeDisplayMessages([], [intermediateReply, finalReply]), [finalReply]);

assert.equal(normalizeSearchQuery("  server   result  "), "server result");
assert.equal(isResourcePinned([{ labelSystemKey: "user:pinned" }]), true);
assert.equal(isResourcePinned([{ labelSystemKey: "other" }]), false);
assert.deepEqual(filterSpaces([{ id: "a", isPinned: true }, { id: "b", isPinned: false }, { id: "c", isPinned: true }], "pinned").map((space) => space.id), ["a", "c"]);
assert.deepEqual(filterSpaces([
  { id: "old", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "new", updatedAt: "2026-09-01T00:00:00.000Z" },
], "recent").map((space) => space.id), ["new", "old"]);
assert.equal(panelForOpeningDelta(30), "chat");
assert.equal(panelForOpeningDelta(-30), "files");
assert.equal(panelForOpeningDelta(0), null);
assert.equal(shouldOpenPanel(100, 360, 0), true);
assert.equal(shouldOpenPanel(10, 360, 0.5), false);
assert.equal(shouldOpenPanel(10, 360, 0.6), true);
assert.equal(shouldClosePanel(180, 360, 0), true);

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
assert.equal(nextChatTailFollowing({ currentlyFollowing: true, distanceToBottom: 420, userInteracting: false, pendingTarget: false }), true);
assert.equal(nextChatTailFollowing({ currentlyFollowing: false, distanceToBottom: 420, userInteracting: false, pendingTarget: false }), false);
assert.equal(nextChatTailFollowing({ currentlyFollowing: true, distanceToBottom: 420, userInteracting: true, pendingTarget: false }), false);
assert.equal(nextChatTailFollowing({ currentlyFollowing: false, distanceToBottom: 20, userInteracting: true, pendingTarget: false }), true);
assert.equal(nextChatTailFollowing({ currentlyFollowing: true, distanceToBottom: 20, userInteracting: false, pendingTarget: true }), false);
assert.equal(nextChatTailFollowing({ currentlyFollowing: false, distanceToBottom: 20, userInteracting: false, pendingTarget: true }), false);

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

console.log("Chat workflow checks passed");
