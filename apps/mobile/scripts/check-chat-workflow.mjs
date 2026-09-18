import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
import ts from "typescript";
import { latestUnreadAssistantIndex } from "../src/data/chat-read-state.ts";
import { ChatScrollTrace, setDebugTraceSink } from "../src/data/chat-scroll-trace.ts";
import { MessageMeasurements, createStreamBatch, liveReplyAnchor, rowHeightMeasurement } from "../src/data/chat-rendering.ts";
import { CHAT_FOLLOW_TAIL_ANIMATE_THRESHOLD, CHAT_FOLLOW_TAIL_MAINTAIN_THRESHOLD, CHAT_TAIL_THRESHOLD, chatFollowPinAnimated, chatListDistances, chatListViewOffset, chatMaintainScrollAtEnd, chatTailScrolledAway, chatTailStalled, isChatRowVisible, nextChatTailFollowing } from "../src/data/chat-scroll.ts";
import { StreamRevealController } from "../src/data/stream-reveal.ts";
import { formatMessageClock } from "../src/data/chat-format.ts";
import { getComposerActionState } from "../src/data/composer-state.ts";
import { imageViewerPageIndex } from "../src/data/image-viewer.ts";
import { collapsedComposerHeight, COMPOSER_CHROME_HEIGHT, COMPOSER_TEXT_PADDING, estimateComposerContentHeight, getComposerLayout, shouldAutoExpandComposer } from "../src/ui/composer-layout.ts";
import { BUBBLE_META_GAP, bubbleTextLines, getBubbleMaxWidth, getBubbleMetaLayout } from "../src/ui/message-bubble-layout.ts";
import { getComposerMenuLayout } from "../src/ui/composer-menu-layout.ts";
import { getAnchoredMenuLayout } from "../src/ui/anchored-menu-layout.ts";
import { interpolateSendBubbleRect, isSendBubbleMessage, measureSendBubbleSource } from "../src/ui/send-bubble-motion.ts";
import { motion } from "../src/motion.ts";
import { getResourcePinState, invalidateResourcePinReads, isResourcePinned, toggleResourcePin } from "../src/data/resource-pins.ts";
import { hasFinalAssistantForTurn, liveStreamStatusFromPatch, shouldShowLiveStream, streamRecoveryFromTail } from "../src/data/chat-stream.ts";
import { fetchSessionLabels, fetchLabelSessionIds, formatLabelRef, isWebSessionSource, sessionSourceGroup, toUserSessionLabels } from "../src/data/session-labels.ts";
import { sessionSourceFilterKeys } from "../src/data/session-source.ts";
import { chatThreadPlaceholder, mergeDisplayMessages, messageIndexForTurn, messagesFromTurns, nextTurnSequence, withFallbackUserContent, withTurnSequences } from "../src/data/session-history.ts";
import { compactionFromMessage, compactionStats } from "../src/data/compaction.ts";
import { mapRemoteSearchResults, normalizeSearchQuery } from "../src/data/session-search.ts";
import { selectSpaceList, recentSpaceVisits, SPACE_VISIT_MAX_AGE_MS } from "../src/data/space-list.ts";
import { createSessionLifecycle } from "../src/data/session-lifecycle.ts";
import { createSyncScheduler } from "../src/data/sync-scheduler.ts";
import { reconcileSessionHead } from "../src/data/session-list-sync.ts";
import { mergeTaskRuns, refreshTaskRuns } from "../src/data/task-sync.ts";
import { emptyRunningSessions, loadRunningSessions, runningSessionCandidates } from "../src/data/running-sessions.ts";
import { createSpaceRealtime } from "../src/data/space-realtime.ts";
import { spaceRealtimeChange } from "../src/data/space-realtime-events.ts";
import { DEFAULT_SESSION_FILTER_MINUTES, getSessionStatus, sessionListStatus, hasMoreRecentSessions, isSessionInFilterWindow, latestTurn, loadSessionLatestTurns, parseSessionFilterMinutes, reconcileLatestTurn, reconcileTurnStatusPatch, sessionFilterCutoff, sessionPageState } from "../src/data/session-status.ts";
import { followupPreviewText, queuedFollowupTurns, followupQueueItems, isOptimisticFollowup, isSendQueueItem, shouldQueueFollowup } from "../src/data/followup-queue.ts";
import { classifySaveConflict, isEditableTextFile, isFileConflictError } from "../src/data/code-file.ts";
import { detectCodeLanguage, resolveCodeLanguage } from "../src/data/code-language.ts";
import { StreamingCodeTokenizer } from "../src/data/code-highlight-stream.ts";
import { connectionDisplayState, createSessionResyncCoordinator, isTransportRecovery } from "../src/data/session-reconnect.ts";
import { panelForScrollOffset } from "../src/data/space-panel-pager.ts";
import { getSpaceSessionCount, loadSpaceSessionCounts, publishSpaceSessionCount } from "../src/data/space-session-counts.ts";
import { cacheRetentionCutoff, DEFAULT_CACHE_RETENTION } from "../src/data/cache-retention.ts";
import { formatToolCallCaption, toolCallPreview } from "../src/data/tool-call.ts";
import { forkSessionTurn } from "../src/data/session-fork.ts";
import { resolveMessageLink } from "../src/data/message-links.ts";
import { androidUpdateApkUrl, selectYaotaAndroidUpdate, validateAndroidUpdateAsset, verifyAndroidUpdateIntegrity } from "../src/data/update-assets.ts";
import { isSettingsSection, settingsMenu } from "../src/data/settings-navigation.ts";
import { parseBrowserPreference } from "../src/data/browser-preference.ts";
import { channelHealthState, createSettingsChannel, createWeChatLoginPoller, isChannelProvider, missingChannelField } from "../src/data/channel-settings.ts";

import { activityRange, localDateKey, tokenDays } from "../src/data/activity.ts";

const flushSync = async () => { for (let tick = 0; tick < 20; tick++) await Promise.resolve(); };
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
try {
  const requests = [];
  const scheduler = createSyncScheduler({ random: () => 0.5 });
  const task = { intervalMs: () => 1000, run: () => { const request = Promise.withResolvers(); requests.push(request); return request.promise; } };
  const stop = scheduler.watch("chats", task);
  const stopSecondReader = scheduler.watch("chats", task);
  mock.timers.tick(5000);
  await flushSync();
  assert.equal(requests.length, 0, "background scopes do not start polling");
  scheduler.setActive(true);
  scheduler.invalidate();
  scheduler.invalidate("chats");
  mock.timers.tick(250);
  await flushSync();
  assert.equal(requests.length, 1, "focus/foreground/reconnect and multiple readers share one request");
  scheduler.invalidate("chats");
  scheduler.invalidate("chats");
  requests[0].resolve();
  await flushSync();
  mock.timers.tick(250);
  await flushSync();
  assert.equal(requests.length, 2, "invalidation during a read queues exactly one follow-up");
  scheduler.setActive(false);
  requests[1].resolve();
  await flushSync();
  mock.timers.tick(10000);
  await flushSync();
  assert.equal(requests.length, 2, "finishing in the background does not restart a timer");
  scheduler.setActive(true);
  mock.timers.tick(250);
  await flushSync();
  assert.equal(requests.length, 3);
  stop();
  stopSecondReader();
  scheduler.dispose();
  requests[2].resolve();
  await flushSync();
  mock.timers.tick(10000);
  await flushSync();
  assert.equal(requests.length, 3, "late old-account completions cannot revive disposed work");

  let attempts = 0;
  const retrying = createSyncScheduler({ active: true, random: () => 0.5 });
  retrying.watch("failed", { intervalMs: () => 1000, run: async () => { attempts++; throw new Error("offline"); } });
  mock.timers.tick(250);
  await flushSync();
  mock.timers.tick(1999);
  await flushSync();
  assert.equal(attempts, 1);
  mock.timers.tick(1);
  await flushSync();
  assert.equal(attempts, 2, "first failure doubles the request interval");
  mock.timers.tick(3999);
  await flushSync();
  assert.equal(attempts, 2);
  retrying.dispose();

  const admitted = [];
  const limited = createSyncScheduler({ active: true, random: () => 0.5 });
  for (let id = 0; id < 6; id++) limited.watch(String(id), { intervalMs: () => 1000, run: () => {
    const request = Promise.withResolvers(); admitted.push(request); return request.promise;
  } });
  mock.timers.tick(250);
  await flushSync();
  assert.equal(admitted.length, 4, "at most four automatic resource operations are admitted");
  admitted[0].resolve();
  await flushSync();
  assert.equal(admitted.length, 5, "queued resources are not starved");
  limited.dispose();
  for (const request of admitted) request.resolve();
  await flushSync();

  let deniedReads = 0;
  const denied = createSyncScheduler({ active: true, random: () => 0.5 });
  denied.watch("denied", { intervalMs: () => 1000, run: async () => { deniedReads++; throw new Error("status batch failed", { cause: { status: 403 } }); } });
  mock.timers.tick(250);
  await flushSync();
  mock.timers.tick(120000);
  await flushSync();
  assert.equal(deniedReads, 1, "permission failures do not retry indefinitely");
  denied.invalidate();
  mock.timers.tick(250);
  await flushSync();
  assert.equal(deniedReads, 2, "explicit invalidation can retry after access changes");
  denied.dispose();

  let suspendedReads = 0;
  const suspended = createSyncScheduler({ active: true });
  suspended.watch("suspended", { intervalMs: () => 1000, run: async () => { suspendedReads++; } });
  mock.timers.tick(250);
  suspended.setActive(false);
  await flushSync();
  assert.equal(suspendedReads, 0, "backgrounding between timer admission and execution suppresses the read");
  suspended.dispose();
} finally { mock.timers.reset(); }

const runningFixture = { id: "ancient", spaceId: "space", title: "Old running Chat", lastMessageAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z", activeTurn: { id: "active", status: "running" } };
const slowRunningTail = Promise.withResolvers();
const runningProgress = [];
const progressiveRunning = loadRunningSessions({ user: { listSessions: async (options) => options.cursor ? slowRunningTail.promise : { sessions: [runningFixture], pageInfo: { hasMore: true, nextCursor: "slow-tail" } } } }, {
  signal: new AbortController().signal,
  onPage: (page) => runningProgress.push(page),
});
await flushSync();
assert.equal(runningProgress.length, 1, "the first Running page publishes without waiting for historical pages");
assert.deepEqual(runningProgress[0], [runningFixture]);
slowRunningTail.resolve({ sessions: [], pageInfo: { hasMore: false, nextCursor: null } });
assert.deepEqual(await progressiveRunning, [runningFixture]);
const discoveryPages = [];
const accountRunning = await loadRunningSessions({ user: { listSessions: async (options) => {
  discoveryPages.push(options);
  if (!options.cursor) return { sessions: Array.from({ length: 60 }, (_, index) => ({ ...runningFixture, id: String(index), activeTurn: null })), pageInfo: { hasMore: true, nextCursor: "older" } };
  if (options.cursor === "older") return { sessions: [], pageInfo: { hasMore: true, nextCursor: "oldest" } };
  return { sessions: [runningFixture], pageInfo: { hasMore: false, nextCursor: null } };
} } }, { source: ["web"], signal: new AbortController().signal });
assert.deepEqual(accountRunning, [runningFixture], "Running discovery reaches older pages and never stops at a time window");
assert.equal(discoveryPages.length, 3);
assert.ok(discoveryPages.every((page) => page.source[0] === "web"), "source membership is filtered by the server on every page");
for (const malformed of [
  { sessions: [{ ...runningFixture, activeTurn: undefined }], pageInfo: { hasMore: false } },
  { sessions: [runningFixture] },
  { sessions: [], pageInfo: { hasMore: true, nextCursor: null } },
]) await assert.rejects(loadRunningSessions({ user: { listSessions: async () => malformed } }, { signal: new AbortController().signal }), /server|pagination/);
await assert.rejects(loadRunningSessions({ user: { listSessions: async () => ({ sessions: [], pageInfo: { hasMore: true, nextCursor: "same" } }) } }, { signal: new AbortController().signal }), /did not advance/);
const discoveryAbort = new AbortController();
let discoveryReads = 0;
await assert.rejects(loadRunningSessions({ user: { listSessions: async () => {
  discoveryReads++;
  discoveryAbort.abort();
  return { sessions: [runningFixture], pageInfo: { hasMore: true, nextCursor: "next" } };
} } }, { signal: discoveryAbort.signal }), /cancelled/);
assert.equal(discoveryReads, 1, "background/account cancellation stops after the in-flight page without publishing partial results");

const roomListeners = new Map();
const roomJoins = [];
const roomLeaves = [];
const roomEvents = [];
const roomErrors = [];
const realtime = createSpaceRealtime({
  subscribe: (id, listener) => { roomJoins.push(id); roomListeners.set(id, listener); return () => roomLeaves.push(id); },
  event: (event) => roomEvents.push(event), error: (error) => roomErrors.push(error),
});
const closeRoomA = realtime.watch(["space", "space"]);
const closeRoomB = realtime.watch(["space"]);
assert.equal(roomJoins.length, 0, "inactive apps do not join Space rooms");
realtime.setActive(true);
assert.deepEqual(roomJoins, ["space"], "multiple focused readers share one SDK subscription");
const removedRoomListener = roomListeners.get("space");
closeRoomA();
assert.equal(roomLeaves.length, 0);
realtime.setActive(false);
removedRoomListener({ type: "space.fs.changed", spaceId: "space", payload: {} });
assert.equal(roomEvents.length, 0, "released/background callbacks cannot update state");
realtime.setActive(true);
assert.equal(roomJoins.length, 2);
roomListeners.get("space")({ type: "system.subscribe.error", payload: { rejected: [{ room: "space:space" }] } });
assert.match(roomErrors.at(-1), /access was rejected/);
const releaseMany = realtime.watch(Array.from({ length: 12 }, (_, id) => `room-${id}`));
assert.equal(roomJoins.length - roomLeaves.length, 10, "room budget counts distinct Space IDs");
closeRoomB();
assert.equal(roomJoins.length - roomLeaves.length, 10, "freeing one room admits the next interested Space");
releaseMany();
realtime.dispose();
assert.equal(roomJoins.length, roomLeaves.length);
assert.deepEqual(spaceRealtimeChange({ type: "session.turn.patch", spaceId: "space", sessionId: "chat", payload: {} }), { exact: [], prefixes: [] }, "token patches never trigger HTTP invalidations");
const fileChange = spaceRealtimeChange({ type: "space.fs.changed", spaceId: "space", payload: {} });
assert.deepEqual(fileChange.prefixes, ["space:space:files:", "space:space:files-panel:"]);
assert.equal(fileChange.exact.length, 0, "file changes do not refetch unrelated task/resource sections");
const finishedTask = spaceRealtimeChange({ type: "task.updated", spaceId: "space", payload: { task: { id: "task", status: "completed" } } });
assert.ok(finishedTask.exact.includes("task:task") && finishedTask.exact.includes("space:space:resources"));
const statusChange = spaceRealtimeChange({ type: "session.turn.updated", spaceId: "space", sessionId: "chat", payload: { turn: { id: "turn", sequence: 2, status: "running", updatedAt: "2026-09-16T00:00:00Z" } } });
assert.equal(statusChange.turn.status, "running");
assert.ok(statusChange.prefixes.includes("running:") && statusChange.prefixes.includes("chats"));
assert.throws(() => spaceRealtimeChange({ type: "session.updated", spaceId: "space", sessionId: "chat", payload: { session: { id: "other", spaceId: "space" } } }), /Invalid realtime/);
assert.throws(() => spaceRealtimeChange({ type: "session.turn.updated", spaceId: "space", sessionId: "chat", payload: { turn: { id: "turn", status: "bogus" } } }), /Invalid realtime/);

mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
try {
  let scans = 0;
  const boundedSync = createSyncScheduler({ active: true, random: () => 0.5 });
  boundedSync.watch("running:all", { intervalMs: () => 120000, minRefreshMs: 30000, run: async () => { scans++; } });
  mock.timers.tick(250);
  await flushSync();
  for (let index = 0; index < 29; index++) { boundedSync.invalidatePrefix("running:"); mock.timers.tick(1000); await flushSync(); }
  assert.equal(scans, 1, "event bursts never cause repeated full-account scans within the cooldown");
  mock.timers.tick(1000);
  await flushSync();
  assert.equal(scans, 2, "continuous invalidations do not postpone the pending scan indefinitely");
  boundedSync.dispose();
} finally { mock.timers.reset(); }

const syncRows = Array.from({ length: 120 }, (_, index) => ({ id: String(1000 - index), spaceId: "space", lastMessageAt: new Date(200000 - index * 1000).toISOString(), updatedAt: new Date(200000 - index * 1000).toISOString() }));
const newHeadRow = { ...syncRows[0], id: "new", lastMessageAt: new Date(201000).toISOString(), updatedAt: new Date(201000).toISOString() };
const mergedHead = reconcileSessionHead(syncRows, [newHeadRow, ...syncRows.slice(0, 59)], true, 300000);
assert.equal(mergedHead.length, 121, "refreshing the first page retains loaded older pages");
assert.ok(mergedHead.some((row) => row.id === syncRows.at(-1).id));
const removedHead = reconcileSessionHead(syncRows, syncRows.slice(1, 61), true, 300000);
assert.ok(!removedHead.some((row) => row.id === syncRows[0].id), "missing rows within the authoritative head boundary are removed");
const eventRow = { ...syncRows[0], updatedAt: new Date(400000).toISOString(), title: "newer event" };
assert.equal(reconcileSessionHead([eventRow], [syncRows[0]], false, 300000)[0].title, "newer event");
assert.equal(reconcileSessionHead([eventRow], [], false, 300000).length, 1, "an event received after the read started survives an empty snapshot");
assert.equal(reconcileSessionHead(syncRows, [], false, 300000).length, 0);
assert.equal(reconcileSessionHead(syncRows, [], true, 300000), syncRows, "an empty nonterminal page cannot prove that cached rows were deleted");

assert.equal(isSettingsSection("channels"), true);
for (const invalid of [undefined, ["channels"], "constructor", "__proto__", "appearance"]) assert.equal(isSettingsSection(invalid), false);
assert.equal(new Set(settingsMenu.map((item) => item.href)).size, settingsMenu.length);
assert.ok(settingsMenu.some((item) => item.href === "/settings/storage"));
assert.ok(settingsMenu.some((item) => item.href === "/settings/channels"));
assert.ok(settingsMenu.some((item) => item.href === "/settings/browser"));
assert.equal(parseBrowserPreference(null), "system");
assert.equal(parseBrowserPreference("in-app"), "in-app");
assert.throws(() => parseBrowserPreference("embedded"), /Invalid browser preference/);
assert.ok(!readFileSync(new URL("../src/components/SettingsScreen.tsx", import.meta.url), "utf8").includes('accessibilityRole="tab"'));
assert.ok(readFileSync(new URL("../src/components/AccountAvatar.tsx", import.meta.url), "utf8").includes('href="/settings"'));
assert.equal(isChannelProvider("wechat"), true);
for (const invalid of ["web", "unknown", ["discord"], undefined]) assert.equal(isChannelProvider(invalid), false);
const channelDraft = { name: " My bot ", token: " token ", appId: " app ", secret: " secret ", brand: "lark" };
assert.equal(missingChannelField("discord", { ...channelDraft, name: " " }), "name");
assert.equal(missingChannelField("discord", { ...channelDraft, token: " " }), "token");
assert.equal(missingChannelField("qq", { ...channelDraft, appId: " " }), "appId");
assert.equal(missingChannelField("feishu", { ...channelDraft, secret: " " }), "secret");
assert.equal(missingChannelField("wechat", { ...channelDraft, token: "", appId: "", secret: "" }), null);
const channelCreates = [];
const channelClient = { channels: { create: async (input) => channelCreates.push(input) } };
for (const provider of ["discord", "feishu", "qq"]) await createSettingsChannel(channelClient, provider, channelDraft);
assert.deepEqual(channelCreates, [
  { provider: "discord", name: "My bot", credentials: { token: "token" } },
  { provider: "feishu", name: "My bot", credentials: { appId: "app", appSecret: "secret", brand: "lark" } },
  { provider: "qq", name: "My bot", credentials: { appId: "app", clientSecret: "secret" } },
]);
await assert.rejects(createSettingsChannel(channelClient, "discord", { ...channelDraft, token: "" }), /token is required/);
assert.equal(channelCreates.length, 3, "invalid channel credentials never reach the SDK");
assert.equal(channelHealthState({ status: "active", boundSpace: null }), "unbound");
assert.equal(channelHealthState({ status: "active", boundSpace: { id: "space" } }), "connecting");
assert.equal(channelHealthState({ health: { state: "error" } }), "error");

const loginEvents = [];
const loginRequests = [];
const loginPoller = createWeChatLoginPoller((input) => new Promise((resolve, reject) => loginRequests.push({ input, resolve, reject })));
const reportLogin = (status) => loginEvents.push(status);
const reportLoginError = (error) => loginEvents.push(error);
const flushLogin = async () => { await Promise.resolve(); await Promise.resolve(); };
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
loginPoller.start("old", 20000, reportLogin, reportLoginError);
loginPoller.stop();
loginRequests[0].resolve({ connected: true, message: "connected" });
await flushLogin();
assert.equal(loginEvents.length, 0, "leaving the screen suppresses a late success");
loginPoller.start("new", 20000, reportLogin, reportLoginError);
loginRequests[1].resolve({ connected: false, needVerifyCode: true, message: "code" });
await flushLogin();
mock.timers.tick(1200);
assert.equal(loginRequests.length, 2, "verification pauses polling");
loginPoller.start("new", 20000, reportLogin, reportLoginError, "123456");
assert.deepEqual(loginRequests[2].input, { sessionKey: "new", verifyCode: "123456" });
loginRequests[2].resolve({ connected: false, message: "confirming" });
await flushLogin();
mock.timers.tick(1200);
assert.deepEqual(loginRequests[3].input, { sessionKey: "new", verifyCode: undefined }, "verification codes are sent once");
loginRequests[3].resolve({ connected: true, message: "connected" });
await flushLogin();
mock.timers.tick(1200);
assert.equal(loginRequests.length, 4, "successful login stops polling");
loginPoller.start("expired", 1000, reportLogin, reportLoginError);
assert.equal(loginEvents.at(-1).expired, true);
assert.equal(loginRequests.length, 4, "expired logins make no network request");
loginPoller.start("failed", 20000, reportLogin, reportLoginError);
const loginError = new Error("Network unavailable");
loginRequests[4].reject(loginError);
await flushLogin();
assert.equal(loginEvents.at(-1), loginError);
loginPoller.stop();
mock.timers.reset();

const activityNow = new Date(2026, 8, 12, 12);
const range = activityRange(activityNow);
assert.equal(range.from.getDay(), 0);
const activityDays = tokenDays([
  { bucketStartAt: new Date(2026, 8, 11, 1).toISOString(), totalTokens: 10 },
  { bucketStartAt: new Date(2026, 8, 11, 2).toISOString(), totalTokens: 30 },
  { bucketStartAt: new Date(2026, 8, 12, 1).toISOString(), totalTokens: 10 },
], range.from, range.to);
assert.equal(activityDays.length, 91);
assert.deepEqual(activityDays.at(-2), { date: "2026-09-11", tokens: 40, level: 4 });
assert.deepEqual(activityDays.at(-1), { date: localDateKey(activityNow), tokens: 10, level: 1 });
assert.equal(activityDays[0].level, 0);
assert.throws(() => tokenDays([{ bucketStartAt: "bad", totalTokens: 1 }], range.from, range.to), /Invalid token/);
assert.throws(() => tokenDays([{ bucketStartAt: activityNow.toISOString(), totalTokens: -1 }], range.from, range.to), /Invalid token/);

// Exercise the shared chrome's real JSX and callbacks without pretending to test native layout.
function loadChromeComponent(path, name, scope) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const statements = source.statements.filter((statement) =>
    (ts.isFunctionDeclaration(statement) && statement.name?.text === name) ||
    (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => declaration.name.getText(source) === "styles"))
  ).map((statement) => statement.getText(source).replace(/^export (?:default )?/, ""));
  const code = ts.transpileModule(`${statements.join("\n")}\nreturn ${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(scope), code)(...Object.values(scope));
}
function chromeNodes(node) {
  if (Array.isArray(node)) return node.flatMap(chromeNodes);
  if (!node || typeof node !== "object") return [];
  return [node, ...chromeNodes(node.props?.children)];
}
const chromeScope = {
  React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: "Fragment" },
  View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable", IconButton: "IconButton", AppIcon: "AppIcon", TopBar: "TopBar",
  StyleSheet: { create: (styles) => styles },
  COMPOSER_TEXT_PADDING,
  edgeChrome: { headerMinHeight: 56, fade: 24 },
  useTranslation: () => ({ t: (key) => key }),
  typography: { heading: { fontSize: 17 }, caption: { fontSize: 12 }, body: { fontSize: 15 } },
  useAppTheme: () => ({ colors: { background: "background", text: "text", textMuted: "muted", textSecondary: "secondary", accent: "accent", accentSoft: "selected", surfacePressed: "pressed" } }),
};
// Data requests triggered by tab focus must not activate the pull-to-refresh control.
for (const [tab, component, expectedRequests] of [
  ["activity", "ActivityScreen", ["activity"]],
  ["spaces", "SpacesScreen", ["home", "spaces"]],
  ["index", "ChatsScreen", ["home"]],
]) {
  let cursor = 0;
  const slots = [];
  const requests = [];
  let pending = Promise.withResolvers();
  const request = (resource) => { requests.push(resource); return pending.promise; };
  const state = { booting: false, refreshing: true, spaces: [], sessions: [], sessionViews: {}, sessionLatestTurns: {}, sessionTurnStatuses: {}, runningSessions: {}, sessionStatusRequests: 0 };
  const spaceList = { loading: true, overview: {}, visits: [], refresh: () => request("spaces") };
  const activityData = { loading: true, credits: { data: { netUsd: 1 }, error: null }, days: { data: [], error: null }, refresh: () => request("activity") };
  const renderTab = loadChromeComponent(`../app/(tabs)/${tab}.tsx`, component, {
    ...chromeScope,
    useState: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: (callback) => callback, useMemo: (factory) => factory(), useEffect: () => {}, useFocusEffect: () => {}, useSyncScope: () => {}, useSpaceRealtime: () => {},
    useRouter: () => ({}), useIsFocused: () => true, useScrollToTop: () => {}, useFloatingTabBarInset: () => 80,
    useEdgeChrome: () => ({ headerHeight: 103, onHeaderLayout: () => {} }), EdgeHeader: "EdgeHeader",
    useApp: () => ({ state, spaceList, userUuid: "user", client: {}, connectionState: "open", refreshHome: () => request("home") }),
    useActivity: () => activityData, useBillingHistory: () => ({ data: null }),
    useAppTheme: () => ({ colors: {}, spacing: {} }),
    useRemoteSearch: () => ({ query: "", sessions: [], spaces: [] }), useSpaceSessionCounts: () => ({}),
    useSourceSessions: () => ({ sessions: [], loading: false, loadingMore: false, error: null, hasMore: false, initialized: true, loadMore: () => {}, reload: () => {} }),
    useSessionFilterPreference: () => ({ loaded: true, minutes: 30 }), loadSessionFilterMinutes: async () => 30,
    useSessionSourcePreference: () => ({ filter: "all", loaded: true, error: null }), saveSessionSourcePreference: async () => {}, loadSessionSourcePreference: async () => "all",
    useToast: () => () => {},
    sessionFilterCutoff, normalizeSearchQuery, selectSpaceList: () => [], emptyRunningSessions, runningSessionCandidates, sessionListStatus,
    CHAT_SEARCH_TYPES: ["session", "turn", "space"], SPACE_SEARCH_TYPES: ["space"],
    Screen: "Screen", ScrollView: "ScrollView", LegendList: "LegendList", RefreshControl: "RefreshControl",
    AccountAvatar: "AccountAvatar", TokenHeatmap: "TokenHeatmap", PressableScale: "PressableScale",
    ConnectionBanner: "ConnectionBanner", DataError: "DataError", LoadingRows: "LoadingRows", SectionHeader: "SectionHeader",
    EmptyState: "EmptyState", ExpandableSearchBar: "ExpandableSearchBar", ActivityIndicator: "ActivityIndicator",
    AdaptiveSheet: "AdaptiveSheet", PrimaryButton: "PrimaryButton", SpaceFilterChip: "SpaceFilterChip", FilterChip: "FilterChip",
    AnchoredActionMenu: "AnchoredActionMenu",
  });
  const render = () => { cursor = 0; return chromeNodes(renderTab()); };
  const control = () => {
    const nodes = render();
    return tab === "activity" ? nodes.find((node) => node.type === "ScrollView").props.refreshControl : nodes.find((node) => node.type === "LegendList");
  };
  const scrollSurface = render().find((node) => node.type === "ScrollView" || node.type === "LegendList");
  assert.equal(render().find((node) => node.type === "Screen").props.edgeToEdge, true);
  assert.equal(scrollSurface.props.contentContainerStyle.paddingTop, 103, `${tab}: initial content clears the measured header`);
  assert.equal(scrollSurface.props.contentContainerStyle.paddingBottom, 80, `${tab}: the last item clears the floating tabs`);
  assert.equal(control().props.progressViewOffset, 103, `${tab}: refresh feedback clears the header`);
  assert.equal(control().props.refreshing, false, `${tab}: automatic loading must not show the pull-to-refresh spinner`);
  assert.equal(requests.length, 0, `${tab}: rendering the refresh control does not start a request`);
  for (const failed of [false, true]) {
    pending = Promise.withResolvers();
    const task = control().props.onRefresh();
    assert.equal(control().props.refreshing, true, `${tab}: the pull gesture immediately shows feedback, even during automatic loading`);
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    assert.deepEqual(requests.splice(0), expectedRequests);
    if (failed) {
      state.error = "Unable to refresh";
      activityData.credits.error = state.error;
    }
    pending.resolve(); // Data hooks report failures in their resource state.
    await task;
    assert.equal(control().props.refreshing, false, `${tab}: completion stops the spinner on success and failure`);
    if (failed) assert.ok(render().some((node) => node.type === "DataError"), `${tab}: refresh errors remain actionable`);
  }
  state.error = null;
  if (tab === "index") {
    state.sessions = [runningFixture];
    state.runningSessions.all = { ...emptyRunningSessions, loading: true };
    chromeNodes(control().props.ListHeaderComponent).find((node) => node.props?.label === "chats.filter.running").props.onPress();
    assert.deepEqual(control().props.data.map((row) => row.session.id), [runningFixture.id], "Running immediately uses known active rows, even years outside the time window");
    assert.ok(control().props.ListFooterComponent, "a partial Running result still indicates an unfinished account scan");
    const laterPage = { ...runningFixture, id: "older-page-running", activeTurn: { id: "older-turn", status: "running" } };
    state.runningSessions.all = { ...emptyRunningSessions, loading: true, sessions: [laterPage] };
    assert.deepEqual(new Set(control().props.data.map((row) => row.session.id)), new Set([runningFixture.id, laterPage.id]), "later discovery pages append without hiding known rows");
    state.sessionTurnStatuses.active = { id: "active", sequence: 1, status: "completed", updatedAt: "2026-09-16T01:00:00Z" };
    assert.deepEqual(control().props.data.map((row) => row.session.id), [laterPage.id], "a known terminal turn is not resurrected by the immediate candidate list");
  }
  if (tab === "spaces") {
    const list = control();
    assert.notEqual(list.props.ListEmptyComponent.type, "LoadingRows", "returning to a loaded empty Spaces list must not flash skeletons");
    spaceList.overview = null;
    assert.equal(control().props.ListEmptyComponent.type, "LoadingRows", "the first Spaces load still has a placeholder");
    assert.equal(control().props.refreshing, false, "the first Spaces load is not a pull gesture");
  }
}

// Real ChatPanel refresh callbacks: server-created label filters and memberships update while open.
{
  let cursor = 0;
  const slots = [];
  const effects = [];
  const jobs = new Map();
  let remoteLabels = [];
  let remoteMembers = [];
  let labelsFetches = 0;
  const client = { space: () => ({ labels: {
    list: async () => { labelsFetches++; return { labels: remoteLabels }; },
    listItems: async () => ({ items: remoteMembers.map((resourceRef) => ({ resourceRef })) }),
  } }) };
  const renderPanel = loadChromeComponent("../src/components/SpacePanels.tsx", "ChatPanel", {
    ...chromeScope,
    useState: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef: (current) => { const index = cursor++; if (!(index in slots)) slots[index] = { current }; return slots[index]; },
    useCallback: (callback) => callback, useMemo: (factory) => factory(),
    useEffect: (callback, deps) => {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
      }
    },
    useSyncScope: (key, run, interval, enabled = true) => { if (enabled) jobs.set(key, { run, interval }); },
    useApp: () => ({ state: {}, sync: { invalidate() {}, invalidatePrefix() {} }, prefetchSession() {}, refreshSessionStatuses: async () => {} }),
    useRemoteSearch: () => ({ query: "", sessions: [], loading: false }),
    fetchSessionLabels, fetchLabelSessionIds, formatLabelRef, toUserSessionLabels, sessionSourceGroup, normalizeSearchQuery,
    mergePanelSessions: (current, incoming) => [...current, ...incoming],
    Avatar: "Avatar", PrimaryButton: "PrimaryButton", SearchField: "SearchField", PanelFilterChip: "PanelFilterChip", ScrollView: "ScrollView", LegendList: "LegendList", SessionLabelSheet: "SessionLabelSheet", ActivityIndicator: "ActivityIndicator",
  });
  const props = { spaceId: "space", spaceName: "Space", sessions: [runningFixture], client, onChipsTouchChange() {}, onClose() {}, onNewChat() {}, onOpenSession() {} };
  const render = () => { cursor = 0; const nodes = chromeNodes(renderPanel(props)); while (effects.length) effects.shift()(); return nodes; };
  render();
  const labelsJob = jobs.get("space:space:labels");
  assert.equal(labelsJob.interval, 15000, "label definitions participate in foreground polling");
  await labelsJob.run();
  remoteLabels = [{ id: "web-label", name: "Created on web", source: "user", systemKey: null }];
  render();
  await jobs.get("space:space:labels").run();
  const chip = render().find((node) => node.type === "PanelFilterChip" && node.props.label === "Created on web");
  assert.ok(chip, "new remote filters appear without closing the panel or pulling to refresh");
  assert.equal(labelsFetches, 2);
  chip.props.onPress();
  render();
  assert.equal(jobs.get("space:space:label-members:Created on web").interval, 15000);
  await jobs.get("space:space:label-members:Created on web").run();
  assert.equal(render().find((node) => node.type === "LegendList").props.data.length, 0);
  remoteMembers = [runningFixture.id];
  await jobs.get("space:space:label-members:Created on web").run();
  assert.equal(render().find((node) => node.type === "LegendList").props.data[0].session.id, runningFixture.id, "label assignments made on the web update the current filtered list");
  const change = spaceRealtimeChange({ type: "label.assignments.updated", spaceId: "space", payload: {} });
  assert.ok(change.exact.includes("space:space:labels"));
  assert.ok(change.prefixes.includes("space:space:label-members:"));
}

for (const success of ["#238552", "#62c994"]) {
  let selected = null;
  const renderHeatmap = loadChromeComponent("../src/components/TokenHeatmap.tsx", "TokenHeatmap", {
    ...chromeScope,
    useState: () => [selected, (value) => { selected = value; }],
    useAppTheme: () => ({ colors: { success, text: "text", textMuted: "muted", surfaceRaised: "empty" }, spacing: { xs: 4, sm: 8, lg: 16 } }),
  });
  const grid = renderHeatmap({ days: activityDays.slice(0, -2) });
  const cells = chromeNodes(grid).filter((node) => node.type === "Pressable");
  assert.equal(cells.length, 91);
  assert.equal(cells.filter((cell) => cell.props.disabled).length, 2, "future days are blank and disabled");
  assert.equal(cells[0].props.style({ pressed: false }).aspectRatio, 1);
  cells[0].props.onPress();
  assert.equal(selected, activityDays[0].date);
  assert.equal(chromeNodes(renderHeatmap({ days: activityDays })).find((node) => node.type === "Pressable").props.accessibilityState.selected, true);
}
for (const background of ["#f7f7f5", "#0f1114", "#000000"]) {
  const renderTopBar = loadChromeComponent("../src/ui.tsx", "TopBar", { ...chromeScope, useAppTheme: () => ({ colors: { background } }) });
  let backCount = 0;
  const header = renderTopBar({ title: "A long inline title", subtitle: "Space / file.ts", onBack: () => backCount++, actions: { type: "actions" } });
  const headerStyle = Object.assign({}, ...header.props.style);
  assert.equal(headerStyle.backgroundColor, background);
  const transparentHeader = renderTopBar({ title: "Chats", transparent: true });
  assert.equal(Object.assign({}, ...transparentHeader.props.style).backgroundColor, "transparent");
  const renderScrim = loadChromeComponent("../src/ui/EdgeChrome.tsx", "EdgeScrim", { ...chromeScope, LinearGradient: "LinearGradient", useAppTheme: () => ({ colors: { background } }) });
  for (const edge of ["top", "bottom"]) {
    const scrim = renderScrim({ edge });
    assert.deepEqual(scrim.props.colors, [background, `${background}f5`, `${background}b8`, `${background}00`]);
    assert.equal(scrim.props.pointerEvents, "none", "the fade never intercepts scrolling or button presses");
    assert.equal(scrim.props.start.y, edge === "top" ? 0 : 1);
    assert.equal(scrim.props.end.y, edge === "top" ? 1 : 0);
  }
  assert.equal(headerStyle.minHeight, 56);
  assert.equal(headerStyle.maxHeight, undefined, "large text must be able to increase header height");
  assert.equal(headerStyle.borderBottomWidth, undefined);
  const headerNodes = chromeNodes(header);
  assert.equal(headerNodes.find((node) => node.props?.accessibilityRole === "header").props.numberOfLines, 1);
  headerNodes.find((node) => node.type === "IconButton").props.onPress();
  assert.equal(backCount, 1);
  assert.ok(headerNodes.some((node) => node.type === "actions"));
  const searchHeader = renderTopBar({ title: "Chats", children: { type: "search-input" } });
  assert.ok(chromeNodes(searchHeader).some((node) => node.type === "search-input"));
  assert.ok(!chromeNodes(searchHeader).some((node) => node.props?.accessibilityRole === "header"), "search replaces the title instead of crowding it");
}
for (const topInset of [24, 103, 160]) {
  const offset = chatListViewOffset(0.15, 8, topInset);
  assert.equal(offset, 8 + Math.max(0, Math.round(topInset * 0.85)), "a jumped-to turn lands below the overlaid chrome");
  assert.equal(chatListDistances(0, 1400 + topInset, 800).distanceToOldest, 0, "the oldest edge is the top of a chronological list");
  assert.equal(chatListDistances(1400 + topInset - 800, 1400 + topInset, 800).distanceToLatest, 0, "the newest edge is the bottom of a chronological list");
}
assert.equal(isChatRowVisible(0, 80, 103, 500), false, "a row behind the header is not read");
assert.equal(isChatRowVisible(610, 80, 103, 500), false, "a row behind the composer is not read");
assert.equal(isChatRowVisible(200, 80, 103, 500), true);
assert.equal(isChatRowVisible(588, 80, 103, 500), false, "less than 20 percent visible is not read");
assert.equal(isChatRowVisible(587, 80, 103, 500), true);
assert.equal(isChatRowVisible(-500, 4000, 103, 500), true, "a long message filling the readable viewport is visible");
assert.equal(isChatRowVisible(200, 0, 103, 500), false);
assert.equal(isChatRowVisible(200, 80, 103, 0), false);

const visibleRowEvents = [];
let viewportHeight = 800;
let rowTop = 680;
const measureRequests = [];
const visibilityCleanups = [];
const renderVisibleRows = loadChromeComponent("../src/components/use-chat-visible-rows.ts", "useChatVisibleRows", {
  useRef: (current) => ({ current }), useCallback: (callback) => callback,
  useEffect: (effect) => { visibilityCleanups.push(effect()); }, isChatRowVisible,
});
const visibleRows = renderVisibleRows({
  viewportRef: { current: { measureInWindow: (callback) => callback(0, 0, 390, viewportHeight) } },
  topInset: 103, bottomInset: 150,
  onVisible: ({ viewableItems }) => visibleRowEvents.push(viewableItems.map((item) => item.key)),
});
visibleRows.trackRow("row", { measureInWindow: (callback) => measureRequests.push(() => callback(0, rowTop, 390, 80)) });
visibleRows.onViewableItemsChanged({ viewableItems: [{ key: "row", isViewable: true, index: 0 }] });
measureRequests.shift()();
assert.deepEqual(visibleRowEvents.at(-1), [], "native measurements exclude a row covered by the composer");
rowTop = 540;
visibleRows.measureVisibleRows();
measureRequests.shift()();
assert.deepEqual(visibleRowEvents.at(-1), ["row"], "scrolling into the readable region updates visibility without a new FlatList candidate event");
viewportHeight = 600;
visibleRows.measureVisibleRows();
measureRequests.shift()();
assert.deepEqual(visibleRowEvents.at(-1), [], "keyboard resize updates the readable viewport");
const previousVisibilityEvents = visibleRowEvents.length;
visibleRows.measureVisibleRows();
visibleRows.onViewableItemsChanged({ viewableItems: [] });
measureRequests.shift()();
assert.equal(visibleRowEvents.length, previousVisibilityEvents + 1, "stale measurements cannot restore outdated read candidates");
visibleRows.onViewableItemsChanged({ viewableItems: [{ key: "row", isViewable: true, index: 0 }] });
visibilityCleanups.forEach((cleanup) => cleanup());
measureRequests.shift()();
assert.equal(visibleRowEvents.length, previousVisibilityEvents + 1, "unmount cancels pending visibility callbacks");

const chatMenuInput = { anchor: { x: 338, y: 53, width: 44, height: 44 }, viewport: { x: 0, y: 47, width: 390, height: 763 }, bottomInset: 34 };
const chatMenuLayout = getAnchoredMenuLayout(chatMenuInput);
assert.deepEqual(chatMenuLayout, { left: 202, top: 54, width: 180, maxHeight: 667 });
assert.equal(getAnchoredMenuLayout({ ...chatMenuInput, contentWidth: 140 }).width, 180, "short menus retain the minimum width");
assert.equal(getAnchoredMenuLayout({ ...chatMenuInput, contentWidth: 230 }).width, 230, "menus expand to their content width");
assert.equal(getAnchoredMenuLayout({ ...chatMenuInput, contentWidth: 400 }).width, 280, "long menus respect the maximum width");
assert.equal(getAnchoredMenuLayout({ ...chatMenuInput, contentWidth: 230, viewport: { ...chatMenuInput.viewport, width: 160 } }).width, 144, "narrow screens take precedence over the minimum width");
assert.equal(chatMenuLayout.left + chatMenuLayout.width, chatMenuInput.anchor.x + chatMenuInput.anchor.width, "menu aligns to the trigger's right edge");
assert.equal(chatMenuLayout.top + chatMenuInput.viewport.y, chatMenuInput.anchor.y + chatMenuInput.anchor.height + 4, "menu opens below the trigger, not from the bottom");
assert.deepEqual(getAnchoredMenuLayout({ ...chatMenuInput, anchor: { ...chatMenuInput.anchor, x: 358, y: 83 }, viewport: { ...chatMenuInput.viewport, x: 20, y: 77 } }), chatMenuLayout, "screen-local coordinates account for safe areas and window offsets");
for (const width of [240, 320, 390, 844]) {
  for (const height of [180, 260, 763]) {
    const layout = getAnchoredMenuLayout({ anchor: { x: width - 52, y: 6, width: 44, height: 44 }, viewport: { x: 0, y: 0, width, height }, bottomInset: 0 });
    assert.ok(layout.left >= 8);
    assert.ok(layout.left + layout.width <= width - 8);
    assert.ok(layout.top + layout.maxHeight <= height - 8);
    assert.ok(layout.maxHeight > 0, "landscape/keyboard-constrained menus must retain scrollable space");
  }
}
const chatMenuEvents = [];
let menuBackHandler;
let menuBackRemoved = false;
let menuFocused = true;
const menuCleanups = [];
const renderChatMenu = loadChromeComponent("../src/components/AnchoredActionMenu.tsx", "AnchoredActionMenu", {
  ...chromeScope,
  ScrollView: "ScrollView",
  useRef: () => ({ current: null }),
  useState: () => [chatMenuLayout, () => undefined],
  useCallback: (callback) => callback,
  useLayoutEffect: () => undefined,
  useEffect: (effect) => { menuCleanups.push(effect()); },
  useSafeAreaInsets: () => ({ bottom: 34 }),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  useIsFocused: () => menuFocused,
  BackHandler: { addEventListener: (name, callback) => { assert.equal(name, "hardwareBackPress"); menuBackHandler = callback; return { remove: () => { menuBackRemoved = true; } }; } },
  getAnchoredMenuLayout,
});
const chatMenuProps = {
  anchorRef: { current: null }, title: "Current chat", testID: "chat-actions-menu", onClose: () => chatMenuEvents.push("close"),
  actions: [
    { icon: "share", title: "Share", onPress: () => chatMenuEvents.push("share") },
    { icon: "tag", title: "Labels", disabled: true, onPress: () => chatMenuEvents.push("labels") },
  ],
};
const menuNodes = chromeNodes(renderChatMenu(chatMenuProps));
const menuItems = menuNodes.filter((node) => node.props?.accessibilityRole === "menuitem");
assert.deepEqual(menuNodes.filter((node) => node.type === "Text").flatMap((node) => node.props.children), ["Share", "Labels"], "action menus show only action names, not a duplicate chat or space title");
assert.equal(menuNodes.find((node) => node.props?.accessibilityRole === "menu").props.accessibilityLabel, "Current chat", "the menu retains its screen-reader context");
assert.equal(menuNodes.find((node) => node.props?.accessibilityRole === "menu").props.testID, "chat-actions-menu");
assert.equal(menuItems.length, 2);
assert.equal(menuItems[1].props.disabled, true);
assert.equal(menuItems[1].props.accessibilityState.disabled, true);
menuItems[0].props.onPress();
assert.deepEqual(chatMenuEvents.splice(0), ["close", "share"], "close the menu before executing Share or opening another surface");
menuNodes.find((node) => node.props?.accessibilityRole === "button").props.onPress();
assert.deepEqual(chatMenuEvents.splice(0), ["close"]);
menuNodes.find((node) => node.props?.accessibilityRole === "menu").props.onAccessibilityEscape();
assert.deepEqual(chatMenuEvents.splice(0), ["close"]);
assert.equal(menuBackHandler(), true);
assert.deepEqual(chatMenuEvents.splice(0), ["close"], "Android back dismisses the menu without navigating away");
assert.equal(menuNodes.find((node) => node.type === "ScrollView").props.keyboardShouldPersistTaps, "always");
assert.ok(!menuNodes.some((node) => node.type === "Modal"), "opening a native share sheet must not compete with another Modal");
menuCleanups[0]();
assert.equal(menuBackRemoved, true);
menuFocused = false;
renderChatMenu(chatMenuProps);
assert.deepEqual(chatMenuEvents.splice(0), ["close"], "leaving the chat must dismiss its menu");

// Read the actual Space menu declaration so the migration cannot silently drop an operation.
const spaceMenuSource = ts.createSourceFile("space.tsx", readFileSync(new URL("../app/space/[spaceId]/index.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let spaceMenuElement;
function findSpaceMenu(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(spaceMenuSource) === "AnchoredActionMenu") spaceMenuElement = node;
  ts.forEachChild(node, findSpaceMenu);
}
findSpaceMenu(spaceMenuSource);
assert.ok(spaceMenuElement);
const spaceMenuActions = spaceMenuElement.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(spaceMenuSource) === "actions").initializer.expression.getText(spaceMenuSource);
const buildSpaceActions = new Function("space", "pinning", "t", "setActivePanel", "togglePin", "router", "checkpointing", "createCheckpoint", ts.transpileModule(`return (${spaceMenuActions});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
for (const isPinned of [false, true]) {
  for (const pinning of [false, true]) {
    const events = [];
    const actions = buildSpaceActions({ id: "space-123", isPinned }, pinning, (key) => key, (panel) => events.push(panel), () => events.push("togglePin"), { push: (route) => events.push(route) }, false, () => events.push("checkpoint"));
    assert.deepEqual(actions.map((action) => action.icon), ["messages", isPinned ? "pin-off" : "pin", "folder-open", "bookmark"]);
    assert.equal(actions[1].title, isPinned ? "space.unpin" : "space.pin");
    assert.equal(actions[1].disabled, pinning);
    menuFocused = true;
    const spaceMenu = renderChatMenu({ anchorRef: { current: null }, title: "Space", testID: "space-actions-menu", onClose: () => events.push("close"), actions });
    assert.equal(chromeNodes(spaceMenu).find((node) => node.props?.accessibilityRole === "menu").props.testID, "space-actions-menu");
    const items = chromeNodes(spaceMenu).filter((node) => node.props?.accessibilityRole === "menuitem");
    items[0].props.onPress();
    assert.deepEqual(events.splice(0), ["close", "chat"]);
    if (!pinning) {
      items[1].props.onPress();
      assert.deepEqual(events.splice(0), ["close", "togglePin"]);
    } else assert.equal(items[1].props.disabled, true);
    items[2].props.onPress();
    assert.deepEqual(events.splice(0), ["close", { pathname: "/space/[spaceId]/files", params: { spaceId: "space-123" } }]);
  }
}

for (const [path, component, labels] of [
  ["../app/(tabs)/index.tsx", "FilterChip", ["All", "Running", "Completed"]],
  ["../app/(tabs)/spaces.tsx", "SpaceFilterChip", ["Recent", "All", "Pinned"]],
]) {
  const renderChip = loadChromeComponent(path, component, { ...chromeScope, PressableScale: "PressableScale" });
  for (const label of labels) {
    for (const selected of [false, true]) {
      let pressed = false;
      const chip = renderChip({ label, selected, icon: label === "Pinned" ? "pin" : undefined, onPress: () => { pressed = true; } });
      assert.equal(chip.props.accessibilityRole, "tab");
      assert.equal(chip.props.accessibilityState.selected, selected);
      assert.equal(chip.props.accessibilityLabel, label);
      assert.deepEqual(chromeNodes(chip).filter((node) => node.type === "Text").flatMap((node) => node.props.children), [label], "filter names must be visible without long-pressing");
      if (label === "Pinned") assert.ok(chromeNodes(chip).some((node) => node.type === "AppIcon" && node.props.name === "pin"));
      chip.props.onPress();
      assert.equal(pressed, true);
    }
  }
}
const renderConnectionBanner = loadChromeComponent("../src/ui.tsx", "ConnectionBanner", chromeScope);
for (const state of ["idle", "connecting", "reconnecting", "open"]) {
  assert.equal(renderConnectionBanner({ state }), null, `routine ${state} state must not show a banner`);
}
for (const state of ["closed", "error"]) {
  const nodes = chromeNodes(renderConnectionBanner({ state }));
  assert.ok(nodes.some((node) => node.type === "AppIcon" && node.props.name === "cloud-off"));
  assert.deepEqual(nodes.filter((node) => node.type === "Text").flatMap((node) => node.props.children), ["ui.banner.unavailable"], "actual connection failures remain visible");
}
let searchExpanded;
let searchQuery = "";
let createdChats = 0;
let keyboardDismissals = 0;
let searchFocuses = 0;
const searchInputRef = { current: { focus: () => searchFocuses++ } };
const exposedSearchRef = { current: null };
const searchEffects = [];
const renderSearchBar = loadChromeComponent("../src/ui/ExpandableSearchBar.tsx", "ExpandableSearchBar", {
  ...chromeScope,
  useState: (initial) => { searchExpanded ??= initial; return [searchExpanded, (value) => { searchExpanded = value; }]; },
  useRef: () => searchInputRef,
  useEffect: (effect) => { searchEffects.push(effect); },
  Keyboard: { dismiss: () => keyboardDismissals++ },
});
const searchProps = () => ({ title: "Chats", query: searchQuery, onQueryChange: (query) => { searchQuery = query; }, queryRef: exposedSearchRef, onCreate: () => createdChats++, createLabel: "New chat" });
const searchAction = (tree, name) => chromeNodes(tree.props.actions).find((node) => node.props?.name === name);
let searchTree = renderSearchBar(searchProps());
assert.equal(chromeNodes(searchTree).some((node) => node.type === "TextInput"), false);
searchAction(searchTree, "plus").props.onPress();
assert.equal(createdChats, 1);
searchAction(searchTree, "search").props.onPress();
searchTree = renderSearchBar(searchProps());
const searchInput = chromeNodes(searchTree).find((node) => node.type === "TextInput");
assert.equal(searchInput.props.autoFocus, true);
assert.equal(searchTree.props.actions, undefined, "empty search has no redundant clear/create controls");
const releaseSearchRef = searchEffects.at(-1)();
assert.equal(exposedSearchRef.current, searchInputRef.current);
searchInput.props.onChangeText("project");
searchTree = renderSearchBar(searchProps());
assert.equal(chromeNodes(searchTree).find((node) => node.type === "TextInput").props.value, "project");
searchAction(searchTree, "x").props.onPress();
assert.equal(searchQuery, "");
assert.equal(searchFocuses, 1);
assert.equal(searchExpanded, true, "clearing search retains the editing mode");
searchInput.props.onChangeText("another query");
searchTree.props.onBack();
assert.equal(searchQuery, "");
assert.equal(searchExpanded, false);
assert.equal(keyboardDismissals, 1);
releaseSearchRef();
assert.equal(exposedSearchRef.current, null);
assert.ok(searchAction(renderSearchBar(searchProps()), "plus"), "closing search restores creation");

const scrollTrace = new ChatScrollTrace();
scrollTrace.record("ignored", "test");
assert.equal(scrollTrace.snapshot().entries.length, 0);
assert.throws(() => scrollTrace.resume(), /Start a recording/);
const debugTraceEvents = [];
setDebugTraceSink((name, fields) => debugTraceEvents.push({ name, fields }));
scrollTrace.start({ platform: "android" });
assert.equal(debugTraceEvents[0].name, "chat.scroll.recording.start");
assert.equal(debugTraceEvents[0].fields.source, "recorder");
assert.equal(scrollTrace.alias("session", "private-session-id"), "session-1");
assert.equal(scrollTrace.alias("session", "private-session-id"), "session-1");
assert.equal(scrollTrace.alias("message", "private-message-id"), "message-1");
for (let index = 0; index < 4010; index++) scrollTrace.record("list.scroll", "test", { y: index });
let traceSnapshot = scrollTrace.snapshot();
assert.equal(traceSnapshot.entries.length, 4000);
assert.equal(traceSnapshot.dropped, 11);
assert.equal(traceSnapshot.entries[0].sequence, 12);
assert.equal(traceSnapshot.entries.at(-1).fields.y, 4009);
assert.ok(traceSnapshot.entries.every((entry, index, entries) => index === 0 || entry.elapsedMs >= entries[index - 1].elapsedMs));
scrollTrace.pause();
const pausedSequence = scrollTrace.snapshot().entries.at(-1).sequence;
scrollTrace.record("ignored", "test");
assert.equal(scrollTrace.snapshot().entries.at(-1).sequence, pausedSequence);
scrollTrace.resume();
assert.equal(scrollTrace.snapshot().entries.at(-1).event, "recording.resume");
const exportedTrace = scrollTrace.export();
assert.equal(exportedTrace.includes("private-session-id"), false);
assert.equal(exportedTrace.includes("private-message-id"), false);
const exportedLines = exportedTrace.split("\n").map((line) => JSON.parse(line));
assert.equal(exportedLines.length, 4001);
assert.equal(exportedLines[0].metadata.platform, "android");
assert.equal(exportedLines[1].sequence, 14);
scrollTrace.reset();
setDebugTraceSink(null);
traceSnapshot = scrollTrace.snapshot();
assert.equal(traceSnapshot.entries.length, 0);
assert.equal(traceSnapshot.recording, false);
assert.equal(traceSnapshot.startedAt, null);
assert.equal(scrollTrace.export().includes("android"), false);
scrollTrace.start({ platform: "ios" });
assert.equal(scrollTrace.alias("session", "different-account"), "session-1");
assert.equal(scrollTrace.snapshot().entries[0].sequence, 1);

const bubbleMeta = { width: 48, height: 16 };
const shortBubble = { width: 40, height: 23, lines: [{ x: 0, y: 0, width: 30, height: 23 }] };
assert.deepEqual(getBubbleMetaLayout(null, bubbleMeta, 280), { minWidth: 0, marginTop: 2, inline: false });
assert.equal(getBubbleMetaLayout(shortBubble, null, 280).inline, false);
const shortLayout = getBubbleMetaLayout(shortBubble, bubbleMeta, 280);
assert.equal(shortLayout.minWidth, 86, "short text may grow to accommodate timestamp and status");
assert.equal(shortLayout.inline, false, "wait for actual expanded width before overlapping the footer row");
assert.deepEqual(getBubbleMetaLayout({ ...shortBubble, width: 86 }, bubbleMeta, 280), { minWidth: 86, marginTop: -14, inline: true });
assert.equal(getBubbleMetaLayout({ ...shortBubble, width: 85.5 }, bubbleMeta, 280).inline, false, "fractional overlap must wrap");
const multiBubble = { width: 260, height: 69, lines: [{ x: 0, y: 0, width: 258, height: 23 }, { x: 0, y: 23, width: 255, height: 23 }, { x: 0, y: 46, width: 60, height: 23 }] };
assert.deepEqual(getBubbleMetaLayout(multiBubble, bubbleMeta, 280), { minWidth: 0, marginTop: -14, inline: true });
assert.equal(getBubbleMetaLayout({ ...multiBubble, lines: [...multiBubble.lines.slice(0, 2), { x: 0, y: 46, width: 250, height: 23 }] }, bubbleMeta, 280).inline, false);
assert.equal(getBubbleMetaLayout({ ...shortBubble, width: 280, lines: [{ x: 230, y: 0, width: 50, height: 23 }] }, bubbleMeta, 280).inline, false, "right-aligned/RTL text cannot be covered by right-aligned metadata");
assert.equal(getBubbleMetaLayout(shortBubble, { width: 290, height: 48 }, 280).minWidth, 280);
assert.equal(getBubbleMetaLayout(shortBubble, { width: 0, height: 0 }, 280).inline, false);
assert.equal(getBubbleMetaLayout({ width: 200, height: 0, lines: [] }, bubbleMeta, 280).inline, false);
// A native text-layout callback must not throw on a missing payload: an uncaught throw there
// is fatal on the new architecture, and an empty measurement keeps the footer in its own row.
assert.deepEqual(bubbleTextLines(undefined), [], "a Text without a lines payload measures as no lines");
assert.deepEqual(bubbleTextLines(null), []);
assert.deepEqual(bubbleTextLines([{ x: 1, y: 2, width: 3, height: 4, ascender: 9 }]), [{ x: 1, y: 2, width: 3, height: 4 }], "only the geometry is kept");
assert.equal(getBubbleMetaLayout({ width: 200, height: 0, lines: bubbleTextLines(null) }, bubbleMeta, 280).inline, false);
// A paginated gallery cannot derive a NaN page from a missing width, and a rubber-band
// offset cannot point past the loaded pages.
assert.equal(imageViewerPageIndex(0, 402, 3), 0);
assert.equal(imageViewerPageIndex(805, 402, 3), 2, "the last page keeps its own offset");
assert.equal(imageViewerPageIndex(5000, 402, 3), 2, "a rubber-band offset stays on the last page");
assert.equal(imageViewerPageIndex(NaN, 402, 3), null, "a missing offset leaves the page alone");
assert.equal(imageViewerPageIndex(402, 0, 3), null, "a page width is required before deriving the page");
assert.equal(imageViewerPageIndex(402, 402, 0), null);
for (const viewport of [240, 320, 360, 390, 768]) {
  assert.ok(getBubbleMaxWidth(viewport) <= viewport - 24);
  for (const scale of [1, 1.3, 2]) {
    for (const lastWidth of [0, 30, 100, 180, 250]) {
      const text = { width: getBubbleMaxWidth(viewport) - 24, height: 46 * scale, lines: [{ x: 0, y: 0, width: 100, height: 23 * scale }, { x: 0, y: 23 * scale, width: lastWidth, height: 23 * scale }] };
      const meta = { width: 48 * scale, height: 16 * scale };
      const result = getBubbleMetaLayout(text, meta, text.width);
      assert.equal(result.minWidth, 0, "multi-line text never changes width for the timestamp");
      if (result.inline) {
        assert.ok(lastWidth + BUBBLE_META_GAP + meta.width <= text.width);
        assert.ok(text.height + result.marginTop >= text.lines[1].y, "tall metadata cannot overlap previous lines");
      } else assert.ok(result.marginTop >= 0);
    }
  }
}

// Execute the real JSX composition to catch a dropped footer between the bubble layers.
const bubbleSource = ts.createSourceFile("MessageContent.tsx", readFileSync(new URL("../src/components/MessageContent.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const bubbleFunctionNames = new Set(["enrichedMarkdownStyle", "TextBlock", "Block", "MessageContent"]);
const bubbleFunctions = bubbleSource.statements.filter((statement) =>
  ts.isFunctionDeclaration(statement) && bubbleFunctionNames.has(statement.name?.text)
).map((statement) => statement.getText(bubbleSource).replace(/^export /, ""));
assert.equal(bubbleFunctions.length, 4);
const bubbleScope = {
  React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: "Fragment" },
  memo: (component) => component,
  useMemo: (factory) => factory(),
  useState: (factory) => [factory()],
  useContext: () => 240,
  useAppTheme: () => ({ colors: { text: "text", textMuted: "muted", accentBorder: "border", accent: "accent", border: "border", surfaceRaised: "raised" } }),
  typography: { chatBody: { fontSize: 15, lineHeight: 23 }, caption: { fontSize: 12, lineHeight: 17 }, code: { fontSize: 12, lineHeight: 19 } },
  scaleFontSize: (size) => size,
  EnrichedMarkdownText: "EnrichedMarkdownText",
  useOpenMessageLink: () => () => {},
  useRevealedStreamText: (text) => text,
  BubbleContext: null,
  BubbleContentWidth: null,
  View: "View", Text: "Text", BubbleText: "BubbleText",
  ImageGallery: "ImageGallery", ToolCall: "ToolCall", SystemNoteRow: "SystemNoteRow",
  imageUri: (block) => block.source?.type === "url" ? block.source.url : null,
};
const bubbleModule = new Function(...Object.keys(bubbleScope), ts.transpileModule(`${bubbleFunctions.join("\n")}\nreturn { MessageContent, enrichedMarkdownStyle };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(bubbleScope));
const bubbleRender = bubbleModule.MessageContent;
const markdownTheme = { colors: { text: "text", textMuted: "muted", accentBorder: "accent-border", accent: "accent", border: "border", surfaceRaised: "raised", userBubbleCodeBackground: "user-code" } };
const userInlineCode = bubbleModule.enrichedMarkdownStyle(markdownTheme, "user-text", "user-link", true).code;
assert.equal(userInlineCode.color, "user-text", "inline code on a user bubble keeps the bubble foreground");
assert.equal(userInlineCode.backgroundColor, "user-code", "inline code on a user bubble uses its theme surface");
const assistantInlineCode = bubbleModule.enrichedMarkdownStyle(markdownTheme, "body-text", "link", false).code;
assert.equal(assistantInlineCode.color, "text");
assert.equal(assistantInlineCode.backgroundColor, "raised");
function footerPlacements(node, footer, found = []) {
  if (Array.isArray(node)) { node.forEach((child) => footerPlacements(child, footer, found)); return found; }
  if (!node || typeof node !== "object") return found;
  if (typeof node.type === "function") return footerPlacements(node.type(node.props), footer, found);
  if (node === footer || node.props?.footer === footer) found.push(node.type);
  footerPlacements(node.props?.children, footer, found);
  return found;
}
const footerMarker = { type: "timestamp", props: {} };
for (const text of ["你好", "First paragraph.\n\nLast paragraph.", "## Heading", "> Quote", "- First\n- Last", "**Bold** and `code`.", "---", "https://example.com/a.mp4", "![image](https://example.com/image)", "```ts\nconst x = 1;\n```", "| A | B |\n| --- | --- |\n| 1 | 2 |"]) {
  for (const active of [false, true]) {
    assert.deepEqual(footerPlacements(bubbleRender({ content: [{ type: "text", text }], active, footer: footerMarker }), footerMarker), ["timestamp"], `native markdown keeps the clock on a sibling row: ${text}`);
  }
}
const streamedFooterSample = "你好，逐字增长。\n\n## Heading\n\n- First\n- Last\n\nDone.";
for (let length = 1; length <= streamedFooterSample.length; length++) {
  const content = [{ type: "thinking", thinking: "Earlier thought." }, { type: "text", text: streamedFooterSample.slice(0, length) }];
  assert.deepEqual(footerPlacements(bubbleRender({ content, active: true, footer: footerMarker }), footerMarker), ["timestamp"], `append ${length} must not remeasure inline metadata`);
}
const bubbleImage = { type: "image", source: { type: "url", url: "fixture://image" } };
assert.deepEqual(footerPlacements(bubbleRender({ content: [bubbleImage], footer: footerMarker }), footerMarker), ["timestamp"]);
assert.deepEqual(footerPlacements(bubbleRender({ content: [bubbleImage, { type: "text", text: "Caption" }], footer: footerMarker }), footerMarker), ["timestamp"]);
assert.deepEqual(footerPlacements(bubbleRender({ content: [{ type: "text", text: "Text" }, { type: "text", text: "  " }], footer: footerMarker }), footerMarker), ["timestamp"]);
assert.deepEqual(footerPlacements(bubbleRender({ content: [{ type: "tool_use", id: "tool", name: "read", input: {} }, { type: "tool_result", tool_use_id: "tool", content: "result" }], footer: footerMarker }), footerMarker), ["timestamp"]);
assert.deepEqual(footerPlacements(bubbleRender({ content: [{ type: "text", text: "No footer" }] }), footerMarker), []);

// Configuration guard, not a native gesture test: the timeline is chronological (no inversion).
const focusPolicySource = ts.createSourceFile("chat.tsx", readFileSync(new URL("../app/chat/[sessionId].tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let timelineElement;
function findTimelineElement(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(focusPolicySource) === "LegendList" && node.attributes.properties.some((prop) => ts.isJsxAttribute(prop) && prop.name.getText(focusPolicySource) === "data" && ts.isJsxExpression(prop.initializer) && prop.initializer.expression?.getText(focusPolicySource) === "messages")) timelineElement = node;
  ts.forEachChild(node, findTimelineElement);
}
findTimelineElement(focusPolicySource);
assert.ok(timelineElement, "the chat timeline renders messages chronologically through LegendList");
const timelineProp = (name) => timelineElement.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(focusPolicySource) === name);
assert.ok(focusPolicySource.text.includes("timelineReady"), "the timeline waits for a tail before mounting so initialScrollAtEnd still applies");
assert.ok(focusPolicySource.text.includes("reserveComposer: true"), "the first paint reserves composer height so the tail does not jump");
assert.ok(timelineProp("alignItemsAtEnd"), "short timelines stick to the bottom");
assert.equal(timelineProp("inverted"), undefined, "the timeline must not be inverted");
assert.equal(timelineProp("experimental_hideItemsUntilMeasured"), undefined, "hiding rows until measured makes the timeline jitter on open");
const initialScrollAtEndProp = timelineProp("initialScrollAtEnd");
assert.ok(initialScrollAtEndProp && ts.isJsxExpression(initialScrollAtEndProp.initializer), "the timeline must start at the tail");
assert.equal(initialScrollAtEndProp.initializer.expression?.getText(focusPolicySource), "!hasInitialTurnTarget");
const itemTypeProp = timelineProp("getItemType");
assert.ok(itemTypeProp && ts.isJsxExpression(itemTypeProp.initializer), "user and assistant rows need separate size averages");
assert.equal(itemTypeProp.initializer.expression?.getText(focusPolicySource), "getMessageItemType");
const onLoadProp = timelineProp("onLoad");
assert.ok(onLoadProp && ts.isJsxExpression(onLoadProp.initializer), "the live card attaches after the history rows are measured");
assert.equal(onLoadProp.initializer.expression?.getText(focusPolicySource), "handleListLoad");
const maintainThresholdProp = timelineProp("maintainScrollAtEndThreshold");
assert.ok(maintainThresholdProp && ts.isJsxExpression(maintainThresholdProp.initializer), "following must keep pinning through a burst larger than Legend's 10% default");
assert.equal(maintainThresholdProp.initializer.expression?.getText(focusPolicySource), "CHAT_FOLLOW_TAIL_MAINTAIN_THRESHOLD");
const focusScrollProp = timelineProp("scrollsChildToFocus");
assert.ok(focusScrollProp && ts.isJsxExpression(focusScrollProp.initializer), "timeline must explicitly disable native focus scrolling");
assert.equal(focusScrollProp.initializer.expression.kind, ts.SyntaxKind.FalseKeyword);

const scrollDebugSource = ts.createSourceFile("chat-scroll.tsx", readFileSync(new URL("../app/debug/chat-scroll.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let scrollFixtureFunction;
function findScrollFixture(node) {
  if (ts.isFunctionExpression(node) && node.name?.text === "ScrollFixture") scrollFixtureFunction = node.getText(scrollDebugSource);
  ts.forEachChild(node, findScrollFixture);
}
findScrollFixture(scrollDebugSource);
assert.ok(scrollFixtureFunction);
let fixtureState;
const scrollFixtureScope = {
  React: bubbleScope.React,
  useRef: (current) => ({ current }),
  useCallback: (callback) => callback,
  useChatScrollTrace: (_source, getState) => { fixtureState = getState; return { recording: false, log: () => {} }; },
  useTraceTouches: () => ({}),
  FlatList: "FlatList", MessageBubble: "MessageBubble",
};
const renderScrollFixture = new Function(...Object.keys(scrollFixtureScope), ts.transpileModule(`return (${scrollFixtureFunction});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(scrollFixtureScope));
for (const enabled of [true, false]) {
  const element = renderScrollFixture({ inverted: true, scrollsChildToFocus: enabled, message: { id: "fixture", sequence: 1 } });
  assert.equal(element.props.scrollsChildToFocus, enabled, "focus toggle reaches the native list prop");
  assert.equal(fixtureState().scrollsChildToFocus, enabled, "fixture trace snapshots record the native focus-scroll setting");
  assert.equal(element.props.inverted, true);
  assert.equal(element.props.scrollEventThrottle, 100);
}

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
// A stale row closure must not reach measure(): an uncaught throw inside a native event
// handler is fatal on the new architecture and freezes the screen until restart.
assert.equal(rowHeightMeasurement(measuredRows, 5, measuredRows[0].id, 200), null, "an out-of-range closure index is skipped, not thrown");
assert.equal(rowHeightMeasurement(measuredRows, 0, "recycled", 200), null, "a recycled row whose id no longer matches the entry is skipped");
assert.equal(rowHeightMeasurement(measuredRows, 0, measuredRows[0].id, 0), null, "recycled zero-height layouts are skipped");
assert.equal(rowHeightMeasurement(measuredRows, 0, measuredRows[0].id, Number.NaN), null, "unsized NaN layouts are skipped");
assert.equal(rowHeightMeasurement(measuredRows, -1, measuredRows[0].id, 200), null);
assert.deepEqual(rowHeightMeasurement(measuredRows, 1, measuredRows[1].id, 120), { message: measuredRows[1], height: 120 }, "valid measurements still record");

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
  // A ZWJ emoji arrives as one grapheme; a multi-grapheme append paces in commits.
  revealed.setTarget("你好👩🏽‍💻");
  mock.timers.tick(50);
  assert.equal(revealed.getDisplayed(), "你好👩🏽‍💻");
  revealed.setTarget("你好👩🏽‍💻abcdefghij");
  const beforePacing = revealedValues.length;
  mock.timers.tick(50);
  assert.ok(revealedValues.length > beforePacing, "appends commit over multiple frames");
  mock.timers.tick(50);
  assert.ok(revealedValues.length > beforePacing + 1, "a long append takes more than one commit");
  for (const value of revealedValues) assert.ok(revealed.getDisplayed().startsWith(value), `revealed value is a prefix: ${value}`);
  mock.timers.tick(600);
  assert.equal(revealed.getDisplayed(), "你好👩🏽‍💻abcdefghij");
  // Never split a grapheme across commits.
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
// Persisted message sequences and turn-projected sequences are independent counters.
const orderingTurn = { id: "ordering-turn", sessionId: "s1", sequence: 10, status: "running", userText: "Question", userContent: [], assistantContent: [], meta: { optimistic: true } };
assert.equal(messagesFromTurns([orderingTurn])[0]?.meta?.optimistic, undefined, "confirmed turn projection never keeps the sending state");
for (const sequence of [2, 12, 80]) {
  const persistedFinal = { id: "persisted-final", sessionId: "s1", role: "assistant", sequence, text: "Answer", content: [], meta: { turnId: orderingTurn.id, messageKind: "assistant_final" } };
  for (const finalized of [false, true]) {
    const turns = [{ ...orderingTurn, ...(finalized ? { status: "completed", assistantText: "Answer" } : {}) }];
    for (const meta of [persistedFinal.meta, { ...persistedFinal.meta, turnSequence: 10 }]) {
      const display = withTurnSequences(mergeDisplayMessages(messagesFromTurns(turns), [{ ...persistedFinal, meta }]), turns);
      assert.deepEqual(display.map((message) => message.role), ["user", "assistant"], "a committed final reply stays after its question before and after turn finalization");
      assert.deepEqual(display.map((message) => message.sequence), [19, 20]);
      assert.equal(display.filter((message) => message.role === "assistant").length, 1);
      assert.equal(shouldShowLiveStream({ status: "streaming", turnId: orderingTurn.id }, display), false);
    }
  }
  assert.equal(persistedFinal.sequence, sequence, "display projection does not mutate the SDK record");
}
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
assert.equal(getSessionStatus("queued"), "running");
assert.equal(getSessionStatus("abort_requested"), "running");
assert.equal(sessionListStatus({ activeTurn: { id: "older-active" } }, completedTurn, {}), "running", "an older active execution can outlive the latest completed turn");
assert.equal(sessionListStatus({ activeTurn: { id: "older-active" } }, completedTurn, { "older-active": { ...completedTurn, id: "older-active" } }), "completed", "a stale activeTurn snapshot cannot resurrect a known terminal turn");
assert.equal(sessionListStatus({ activeTurn: null }, undefined, {}), "idle", "no active turn does not imply completion");
for (const status of ["in_progress", "pending", "needs_input", "waiting", "completed", "failed", "interrupted", "merged", "cancelled", null, undefined]) {
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
    { id: "recent", spaceId: "space1", createdAt: "2026-01-01T00:00:00.000Z", lastMessageAt: "2026-09-08T11:59:00.000Z" },
    { id: "boundary", spaceId: "space1", lastMessageAt: "2026-09-08T11:30:00.000Z" },
    { id: "old", spaceId: "space1", status: "running", lastMessageAt: "2026-09-08T11:29:59.999Z", updatedAt: "2026-09-08T11:59:00.000Z" },
    { id: "no-messages", spaceId: "space1", lastMessageAt: null },
  ];
  await loadSessionLatestTurns(recentStatusClient, sessions, (id) => recentStatusResults.push(id));
  assert.deepEqual(recentStatusCalls, ["recent", "boundary"]);
  assert.deepEqual(recentStatusResults, ["recent", "boundary"]);
  recentStatusCalls.length = 0;
  await loadSessionLatestTurns(recentStatusClient, [sessions[2]], () => assert.fail("Old sessions must not publish a status"));
  assert.deepEqual(recentStatusCalls, []);
  await assert.rejects(loadSessionLatestTurns(recentStatusClient, [{ id: "invalid", spaceId: "space1", lastMessageAt: "not-a-date" }], () => assert.fail("Invalid activity dates must not publish a status")), /Invalid lastMessageAt for Chat invalid/);
  assert.deepEqual(recentStatusCalls, []);
  await loadSessionLatestTurns(recentStatusClient, sessions, () => undefined, 60);
  assert.deepEqual(recentStatusCalls, ["recent", "boundary", "old"], "a wider setting queries older message activity");
  recentStatusCalls.length = 0;
  await loadSessionLatestTurns(recentStatusClient, sessions, () => undefined, 5);
  assert.deepEqual(recentStatusCalls, ["recent"], "a shorter setting narrows status requests");
  recentStatusCalls.length = 0;
  mock.timers.tick(31 * 60 * 1000);
  await loadSessionLatestTurns(recentStatusClient, sessions, () => assert.fail("The recent window must advance on every refresh"));
  assert.deepEqual(recentStatusCalls, []);
} finally {
  mock.timers.reset();
}

assert.equal(DEFAULT_SESSION_FILTER_MINUTES, 30);
assert.equal(parseSessionFilterMinutes(" 45 "), 45);
assert.equal(parseSessionFilterMinutes("1"), 1);
assert.equal(parseSessionFilterMinutes("1440"), 1440);
for (const invalid of ["", "0", "-1", "1.5", "1441", "1e2", "30minutes", "Infinity"]) {
  assert.throws(() => parseSessionFilterMinutes(invalid), /whole number of minutes/);
}
const filterNow = Date.parse("2026-09-10T12:00:00.000Z");
const filterCutoff = sessionFilterCutoff(30, filterNow);
const recentBoundary = { lastMessageAt: "2026-09-10T11:30:00.000Z" };
const oldBoundary = { lastMessageAt: "2026-09-10T11:29:59.999Z" };
assert.equal(isSessionInFilterWindow(recentBoundary, filterCutoff), true);
assert.equal(isSessionInFilterWindow(oldBoundary, filterCutoff), false);
assert.equal(isSessionInFilterWindow({ lastMessageAt: null }, filterCutoff), false);
assert.equal(isSessionInFilterWindow(oldBoundary, sessionFilterCutoff(60, filterNow)), true);
assert.equal(isSessionInFilterWindow(recentBoundary, sessionFilterCutoff(30, filterNow + 1)), false, "entries expire as time advances");
const recentPaging = { hasMore: true, cursor: "next-page", boundary: recentBoundary, cutoff: filterCutoff };
assert.equal(hasMoreRecentSessions(recentPaging), true);
assert.equal(hasMoreRecentSessions({ ...recentPaging, boundary: oldBoundary }), false, "an old page stops filtered pagination even if older history remains");
assert.equal(hasMoreRecentSessions({ ...recentPaging, cursor: null }), false, "no unserviceable loading indicator without a cursor");
assert.equal(hasMoreRecentSessions({ ...recentPaging, hasMore: false }), false);
assert.equal(hasMoreRecentSessions({ ...recentPaging, boundary: { lastMessageAt: null } }), false, "null activity rows are last in server order");
assert.equal(hasMoreRecentSessions({ ...recentPaging, boundary: null }), true, "an empty permission-filtered page may still have recent results beyond it");
const recentPage = sessionPageState({ sessions: [recentBoundary], pageInfo: { hasMore: true, nextCursor: "recent-cursor" } });
const emptyVisiblePage = sessionPageState({ sessions: [], pageInfo: { hasMore: true, nextCursor: "gap-cursor" } }, recentPage.cursor, recentPage.boundary);
assert.deepEqual(emptyVisiblePage, { hasMore: true, cursor: "gap-cursor", boundary: recentBoundary });
const oldPage = sessionPageState({ sessions: [oldBoundary], pageInfo: { hasMore: true, nextCursor: "old-cursor" } }, emptyVisiblePage.cursor, emptyVisiblePage.boundary);
assert.equal(hasMoreRecentSessions({ ...oldPage, cutoff: filterCutoff }), false, "recent, permission-gap, old-page traversal terminates");
assert.equal(oldPage.hasMore, true, "All still has access to older pages");
assert.throws(() => sessionPageState({ sessions: [], pageInfo: { hasMore: true, nextCursor: null } }), /pagination did not advance/);
assert.throws(() => sessionPageState({ sessions: [], pageInfo: { hasMore: true, nextCursor: "same" } }, "same"), /pagination did not advance/);
assert.throws(() => sessionPageState({ sessions: [{ id: "broken", lastMessageAt: "not-a-date" }] }), /Invalid lastMessageAt/);
assert.deepEqual(sessionPageState({ sessions: [], pageInfo: { hasMore: false, nextCursor: null } }), { hasMore: false, cursor: null, boundary: null });

// Exercise the provider's real pagination callback with React's child-before-parent passive effect order.
const contextSource = ts.createSourceFile("context.tsx", readFileSync(new URL("../src/data/context.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let paginationCallback;
let refreshChatsCallback;
let stateSyncHook;
let timeoutSource;
const sessionCallbacks = {};
function inspectPagination(node) {
  if (ts.isVariableDeclaration(node) && ["openSession", "closeSession", "loadSession", "releaseSession", "sendMessage"].includes(node.name.getText(contextSource))) {
    const callback = node.initializer;
    if (ts.isCallExpression(callback) && callback.expression.getText(contextSource) === "useCallback") sessionCallbacks[node.name.getText(contextSource)] = callback.arguments[0].getText(contextSource);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(contextSource) === "loadMoreSessions") paginationCallback = node.initializer.arguments[0].getText(contextSource);
  if (ts.isVariableDeclaration(node) && node.name.getText(contextSource) === "refreshChats") refreshChatsCallback = node.initializer.arguments[0].getText(contextSource);
  if (ts.isCallExpression(node) && ["useEffect", "useLayoutEffect"].includes(node.expression.getText(contextSource)) && node.arguments[0]?.getText(contextSource).includes("stateRef.current = state;")) stateSyncHook = node.expression.getText(contextSource);
  if (ts.isFunctionDeclaration(node) && node.name?.text === "withTimeout") timeoutSource = node.getText(contextSource);
  ts.forEachChild(node, inspectPagination);
}
inspectPagination(contextSource);
assert.ok(paginationCallback && stateSyncHook && timeoutSource);
const listReducerSource = contextSource.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "reducer");
const latestStatusSource = contextSource.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "updateLatestTurn");
const reduceListSync = new Function("sortByRecent", "reconcileSessionHead", "reconcileLatestTurn", "reconcileTurnStatusPatch", "emptyRunningSessions", "isActiveTurnStatus", ts.transpileModule(`${latestStatusSource.getText(contextSource)}\n${listReducerSource.getText(contextSource)}\nreturn reducer;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
  (rows) => [...rows].sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt)), reconcileSessionHead, reconcileLatestTurn, reconcileTurnStatusPatch, emptyRunningSessions, (status) => ["queued", "running", "abort_requested"].includes(status),
);
const listSyncState = {
  sessions: syncRows, sessionsPagesLoaded: 2, sessionsHasMore: true, sessionsCursor: "tail-cursor", sessionsPageBoundary: { lastMessageAt: syncRows.at(-1).lastMessageAt },
  sessionsLoadingMore: false, sessionViews: { chat: { messages: ["optimistic"], oldestCursor: 20, newestCursor: 50 } }, sessionLatestTurns: {}, sessionTurnStatuses: {}, runningSessions: {}, realtimeError: null, sessionStatusRequests: 0,
};
const refreshedList = reduceListSync(listSyncState, { type: "sessions-head-success", sessions: [newHeadRow, ...syncRows.slice(0, 59)], hasMore: true, cursor: "new-head-cursor", boundary: { lastMessageAt: syncRows[58].lastMessageAt }, requestStartedAt: 300000 });
assert.equal(refreshedList.sessionsCursor, "tail-cursor");
assert.equal(refreshedList.sessionsPageBoundary, listSyncState.sessionsPageBoundary);
assert.equal(refreshedList.sessions.length, 121);
assert.equal(refreshedList.sessionViews, listSyncState.sessionViews, "list polling never replaces an open Chat history window or optimistic messages");
const completeHead = reduceListSync(listSyncState, { type: "sessions-head-success", sessions: syncRows.slice(0, 5), hasMore: false, cursor: null, boundary: { lastMessageAt: syncRows[4].lastMessageAt }, requestStartedAt: 300000 });
const lateTail = reduceListSync(completeHead, { type: "sessions-more-success", sessions: syncRows.slice(60), hasMore: false, cursor: null, boundary: listSyncState.sessionsPageBoundary });
assert.equal(lateTail.sessions, completeHead.sessions, "an old in-flight tail cannot restore rows removed by a complete head snapshot");
const backgroundStatusStart = reduceListSync(listSyncState, { type: "session-status-start", silent: true });
assert.equal(backgroundStatusStart.sessionStatusRequests, 0, "automatic status probes do not flash empty-list skeletons");
assert.equal(reduceListSync(backgroundStatusStart, { type: "session-status-end", silent: true }).sessionStatusRequests, 0);
const newerOutcome = reduceListSync(listSyncState, { type: "session-latest-turn", sessionId: "chat", turn: { ...completedTurn, sequence: 10 } });
const olderOutcome = reduceListSync(newerOutcome, { type: "session-latest-turn", sessionId: "chat", turn: { ...completedTurn, id: "older", sequence: 9 } });
assert.equal(olderOutcome.sessionLatestTurns.chat.sequence, 10);
assert.equal(olderOutcome.sessionTurnStatuses.older.status, "completed", "older active-turn reconciliation records its terminal state without replacing the latest outcome");
const partialRunningState = reduceListSync(listSyncState, { type: "running-success", source: "all", sessions: [runningFixture], changedSessionIds: [], complete: false });
assert.equal(partialRunningState.runningSessions.all.loading, true);
assert.equal(partialRunningState.runningSessions.all.loaded, false, "a first page must not claim account-wide coverage");
assert.deepEqual(partialRunningState.runningSessions.all.sessions, [runningFixture]);
const cancelledPartial = reduceListSync(partialRunningState, { type: "running-end", source: "all" });
assert.deepEqual(cancelledPartial.runningSessions.all.sessions, [runningFixture]);
assert.equal(cancelledPartial.runningSessions.all.loading, false);
const idleRunningPage = reduceListSync(partialRunningState, { type: "running-success", source: "all", sessions: [{ ...runningFixture, activeTurn: null }], changedSessionIds: [], complete: false });
assert.equal(idleRunningPage.runningSessions.all.sessions.length, 0, "a scanned idle row removes only that row from a partial snapshot");
const partialError = reduceListSync(partialRunningState, { type: "running-end", source: "all", error: "older page failed" });
assert.equal(partialError.runningSessions.all.loaded, false);
assert.equal(partialError.runningSessions.all.sessions.length, 1, "a failed historical page retains already discovered running rows");
const discoveredState = reduceListSync(listSyncState, { type: "running-success", source: "all", sessions: [runningFixture], changedSessionIds: [] });
assert.equal(discoveredState.sessions, listSyncState.sessions, "discovery must not contaminate the ordinary paginated list");
assert.equal(discoveredState.sessionsCursor, "tail-cursor");
const finalEventState = reduceListSync(discoveredState, { type: "session-realtime-turn", sessionId: runningFixture.id, turn: { ...completedTurn, id: "active" } });
const lateScanState = reduceListSync(finalEventState, { type: "running-success", source: "all", sessions: [runningFixture], changedSessionIds: [runningFixture.id] });
assert.equal(sessionListStatus(lateScanState.runningSessions.all.sessions[0], lateScanState.sessionLatestTurns[runningFixture.id], lateScanState.sessionTurnStatuses), "completed", "an old scan cannot resurrect a turn finalized by realtime");
const failedScanState = reduceListSync(discoveredState, { type: "running-end", source: "all", error: "discovery failed" });
assert.equal(failedScanState.runningSessions.all.sessions, discoveredState.runningSessions.all.sessions);
assert.equal(failedScanState.runningSessions.all.error, "discovery failed");
const unrelatedEvent = reduceListSync(discoveredState, { type: "session-realtime-turn", sessionId: "other-user-chat", turn: runningTurn });
assert.deepEqual(unrelatedEvent.runningSessions.all.sessions, discoveredState.runningSessions.all.sessions, "Space room membership alone does not admit a Chat into the user inbox");
const pageTimeout = new Function("HOME_REQUEST_TIMEOUT_MS", "translate", `${ts.transpileModule(timeoutSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return withTimeout;`)(15000, (_key, values) => `Timed out: ${values.label}`);
function paginationHarness(listSessions) {
  const stateRef = { current: { sessionsLoadingMore: true, sessionsHasMore: true, sessionsCursor: "old-page", refreshing: false, sessionsPageBoundary: recentBoundary } };
  const calls = [];
  const actions = [];
  const requestRef = { current: null };
  const generationRef = { current: 1 };
  const client = { user: { listSessions: (options) => { calls.push(options.cursor); return listSessions(options); } } };
  const load = new Function("stateRef", "client", "sessionsMoreRequestRef", "homeRefreshGenerationRef", "dispatch", "withTimeout", "sessionPageState", "refreshSessionStatuses", "saveSessions", "userKey", "errorMessage", "translate", `return ${paginationCallback}`)(stateRef, client, requestRef, generationRef, (action) => actions.push(action), pageTimeout, sessionPageState, () => {}, async () => {}, "test-user", (error) => error.message, (key) => key);
  return { load, calls, actions, requestRef, generationRef, stateRef };
}
// Provider effects can be cleaned up and restarted without recreating useState controllers.
const syncEffects = [];
let spaceRealtimeEffect;
function inspectSyncEffects(node) {
  if (ts.isCallExpression(node) && node.expression.getText(contextSource) === "useEffect" && node.arguments[1]?.getText(contextSource) === "[sync]") syncEffects.push(node.arguments[0].getText(contextSource));
  if (ts.isCallExpression(node) && node.expression.getText(contextSource) === "useEffect" && node.arguments[1]?.getText(contextSource) === "[spaceRealtime]") spaceRealtimeEffect = node.arguments[0].getText(contextSource);
  ts.forEachChild(node, inspectSyncEffects);
}
inspectSyncEffects(contextSource);
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
try {
  const sync = createSyncScheduler({ active: true, random: () => 0.5 });
  const scope = {
    sync, NativeAppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
    runningDiscoveryControllers: { current: new Set() }, subscriptions: { current: new Map() }, resyncCoordinatorRef: { current: { request: () => {} } },
  };
  const effects = syncEffects.map((effect) => new Function(...Object.keys(scope), `return (${effect});`)(...Object.values(scope)));
  for (const cleanup of effects.map((effect) => effect())) cleanup?.();
  const cleanups = effects.map((effect) => effect());
  let reads = 0;
  const stop = sync.watch("chats", { intervalMs: () => 15000, run: async () => { reads++; } });
  mock.timers.tick(250);
  await flushSync();
  mock.timers.tick(15000);
  await flushSync();
  assert.equal(reads, 2, "effect cleanup/restart must not permanently disable the account scheduler");
  stop();
  for (const cleanup of cleanups) cleanup?.();
  sync.dispose();

  let events = 0;
  let listener;
  let subscribed = 0;
  const spaceRealtime = createSpaceRealtime({
    subscribe: (_id, callback) => { listener = callback; subscribed++; return () => { subscribed--; }; },
    event: () => { events++; }, error: () => {},
  });
  const restartEffect = new Function("spaceRealtime", "NativeAppState", `return (${spaceRealtimeEffect});`)(spaceRealtime, scope.NativeAppState);
  restartEffect()();
  const stopEffect = restartEffect();
  const stopRoom = spaceRealtime.watch(["visible-space"]);
  assert.equal(subscribed, 1, "restarting provider effects must restore Space subscriptions");
  listener({ type: "session.created", spaceId: "visible-space" });
  assert.equal(events, 1);
  stopRoom();
  stopEffect();
  assert.equal(subscribed, 0, "unmount releases native room listeners");
} finally { mock.timers.reset(); }

// Exercise the actual provider callback through its scheduler, not just isolated timers.
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
try {
  for (const statusFailure of ["forbidden", "slow"]) {
    let reads = 0;
    const actions = [];
    const slowStatus = Promise.withResolvers();
    const scope = {
      homeRefreshRequestRef: { current: null }, chatsRefreshRequestRef: { current: null }, homeRefreshGenerationRef: { current: 0 },
      client: { user: { listSessions: async () => ({ sessions: [{ ...syncRows[0], id: `web-created-${++reads}` }], pageInfo: { hasMore: false, nextCursor: null } }) } },
      withTimeout: pageTimeout, sessionPageState, dispatch: (action) => actions.push(action), saveSessions: async () => {}, userKey: "test",
      errorMessage: (error) => error.message, translate: (key) => key,
      refreshSessionStatuses: async (_sessions, options) => {
        if (statusFailure === "slow") return slowStatus.promise;
        if (options.throwOnError) throw new Error("one Chat status is forbidden", { cause: { status: 403 } });
      },
    };
    const refresh = new Function(...Object.keys(scope), ts.transpileModule(`return (${refreshChatsCallback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(scope));
    const scheduler = createSyncScheduler({ active: true, random: () => 0.5 });
    scheduler.watch("chats", { run: refresh, intervalMs: () => 15000 });
    mock.timers.tick(250);
    await flushSync();
    mock.timers.tick(15000);
    await flushSync();
    assert.equal(reads, 2, `${statusFailure}: status enrichment must not stop discovery of new web Chats`);
    assert.equal(actions.filter((action) => action.type === "sessions-head-success").at(-1).sessions[0].id, "web-created-2");
    assert.ok(!actions.some((action) => action.type === "sessions-head-error"), "status errors do not become list errors");
    scheduler.dispose();
    slowStatus.resolve();
    await flushSync();
  }
} finally { mock.timers.reset(); }

const handoff = paginationHarness(async () => ({ sessions: [], pageInfo: { hasMore: false, nextCursor: null } }));
const nextPageState = { ...handoff.stateRef.current, sessionsLoadingMore: false, sessionsCursor: "next-page" };
if (stateSyncHook === "useLayoutEffect") handoff.stateRef.current = nextPageState;
await handoff.load();
if (stateSyncHook === "useEffect") handoff.stateRef.current = nextPageState;
assert.deepEqual(handoff.calls, ["next-page"], "a completed page must request the next page instead of leaving a spinner with no active request");
assert.equal(handoff.actions.at(-1).type, "sessions-more-success");
assert.equal(handoff.requestRef.current, null);

mock.timers.enable({ apis: ["setTimeout"] });
try {
  const stalledPage = paginationHarness(() => new Promise(() => {}));
  stalledPage.stateRef.current = nextPageState;
  const pendingPage = stalledPage.load();
  mock.timers.tick(15000);
  await pendingPage;
  assert.equal(stalledPage.actions.at(-1).type, "sessions-more-error");
  assert.match(stalledPage.actions.at(-1).message, /Timed out/);
  assert.equal(stalledPage.requestRef.current, null, "timeouts release the pagination request for retry");
} finally {
  mock.timers.reset();
}
let resolveStalePage;
const stalePage = paginationHarness(() => new Promise((resolve) => { resolveStalePage = resolve; }));
stalePage.stateRef.current = nextPageState;
const pendingStalePage = stalePage.load();
stalePage.generationRef.current += 1;
resolveStalePage({ sessions: [oldBoundary], pageInfo: { hasMore: false, nextCursor: null } });
await pendingStalePage;
assert.deepEqual(stalePage.actions.map((action) => action.type), ["sessions-more-start"], "an old page cannot replace a newly refreshed list or cursor");

// Space first paint must not wait for optional pin metadata or the slowest resource endpoint.
const spaceScreenSource = ts.createSourceFile("space.tsx", readFileSync(new URL("../app/space/[spaceId]/index.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const spaceCallbacks = {};
function inspectSpaceCallbacks(node) {
  if (ts.isVariableDeclaration(node) && ["loadSpace", "loadResources"].includes(node.name.getText(spaceScreenSource))) {
    spaceCallbacks[node.name.getText(spaceScreenSource)] = node.initializer.arguments[0].getText(spaceScreenSource);
  }
  ts.forEachChild(node, inspectSpaceCallbacks);
}
inspectSpaceCallbacks(spaceScreenSource);
const compileSpaceCallback = (name, scope) => new Function(...Object.keys(scope), ts.transpileModule(`return (${spaceCallbacks[name]});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(scope));
const slowPin = Promise.withResolvers();
const paintedSpaces = [];
const loadSpaceImmediately = compileSpaceCallback("loadSpace", {
  client: { spaces: { get: async () => ({ id: "space", name: "Fast Space" }) } }, spaceId: "space",
  spaceRefreshInFlightRef: { current: null }, spaceRefreshAtRef: { current: null }, cachedSpaceRef: { current: null }, SPACE_REFRESH_INTERVAL_MS: 60_000,
  spaceRefreshTokenRef: { current: 0 }, setSpaceLoading() {}, setSpaceError() {}, refreshSpacePin: () => slowPin.promise,
  setLoadedSpace: (space) => paintedSpaces.push(space), upsertSpace() {}, t: (key) => key, console,
});
const pendingSpacePaint = loadSpaceImmediately();
await flushSync();
assert.equal(paintedSpaces.length, 1, "Space shell paints when its detail request resolves, without waiting for pin metadata");
let cachedSpaceGets = 0;
const loadCachedSpace = compileSpaceCallback("loadSpace", {
  client: { spaces: { get: async () => { cachedSpaceGets++; return { id: "space" }; } } }, spaceId: "space",
  spaceRefreshInFlightRef: { current: null }, spaceRefreshAtRef: { current: null }, cachedSpaceRef: { current: { id: "space", name: "Cached", isPinned: true } }, SPACE_REFRESH_INTERVAL_MS: 60_000,
  spaceRefreshTokenRef: { current: 0 }, setSpaceLoading() {}, setSpaceError() {}, refreshSpacePin: async () => false,
  setLoadedSpace() {}, upsertSpace() {}, t: (key) => key, console,
});
await loadCachedSpace();
assert.equal(cachedSpaceGets, 0, "a cached Space does not block its first render on a duplicate metadata request");
slowPin.resolve(false);
await pendingSpacePaint;
const slowApps = Promise.withResolvers();
const resourcePaints = [];
const loadResourcesProgressively = compileSpaceCallback("loadResources", {
  client: {
    space: () => ({ checkpoints: { list: async () => ({ checkpoints: [{ id: "save" }] }) } }),
    apps: { listBySpace: () => slowApps.promise }, tasks: { list: async () => ({ runs: [{ id: "task" }] }) },
  },
  spaceId: "space", resourcesInFlightRef: { current: false }, resourcesRefreshAtRef: { current: 0 }, SPACE_REFRESH_INTERVAL_MS: 60_000,
  resourcesRequestRef: { current: 0 }, tasksRequestRef: { current: 0 }, allResourcesLoading: { checkpoints: true, apps: true, tasks: true },
  setResourceLoading() {}, setResources: (update) => resourcePaints.push(update({ checkpoints: [], apps: [], tasks: [] })), setResourceFailures() {}, setTaskCursor() {},
  mergeTaskRuns: (current, incoming) => [...current, ...incoming],
});
const pendingResourcePaint = loadResourcesProgressively();
await flushSync();
assert.ok(resourcePaints.some((resource) => resource.checkpoints.length === 1), "Saves render before a slower Works request settles");
assert.ok(resourcePaints.some((resource) => resource.tasks.length === 1), "Tasks render before a slower Works request settles");
slowApps.resolve({ apps: [] });
await pendingResourcePaint;

// Reopening hydrated history must not read and replace it with the older disk cache.
const reopenActions = [];
let reopenCacheReads = 0;
let reopenRefreshes = 0;
let reopenAttachments = 0;
const reopenView = { historyLoaded: true, messages: [{ id: "live" }], session: { id: "session", spaceId: "space" }, space: { id: "space" } };
const reopenScope = {
  client: { space: () => ({ session: () => ({ turns: { listPaginated: async () => ({ turns: [], hasMore: false }) } }) }) },
  openTokens: { current: new Map() },
  stateRef: { current: { sessions: [reopenView.session], spaces: [reopenView.space], sessionViews: { session: reopenView } } },
  dispatch: (action) => reopenActions.push(action),
  loadMessages: async () => { reopenCacheReads += 1; return []; },
  userKey: "test-user",
  recordSpaceVisit: () => {},
  attachSessionRealtime: () => { reopenAttachments += 1; },
  refreshSession: async (_id, options) => { assert.equal(options.silent, true); reopenRefreshes += 1; },
  messagesFromTurns: () => [],
  isLiveMessage: () => false,
  mergeDisplayMessages: (messages) => messages,
  loadTurnIndex: async () => {},
  saveMessages: async () => {},
  markChatEntry: () => {},
  startChatEntry: () => {},
  translate: (key) => key,
  withTimeout: pageTimeout,
};
const reopenSource = sessionCallbacks.loadSession ?? sessionCallbacks.openSession;
const reopen = new Function(...Object.keys(reopenScope), ts.transpileModule(`return (${reopenSource});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(reopenScope));
await reopen("session");
assert.equal(reopenCacheReads, 0, "warm opens must not rehydrate the entire SQLite history");
assert.equal(reopenActions.some((action) => action.type === "session-start"), false, "warm opens keep historyLoaded and pagination available");
assert.equal(reopenAttachments, 1, "after subscription release, warm opens still recover the authoritative stream");
assert.equal(reopenRefreshes, 1, "memory reuse still reconciles the server tail");

// A cold open must fail visibly instead of waiting forever on a stalled history request.
mock.timers.enable({ apis: ["setTimeout"] });
try {
  const coldActions = [];
  const coldScope = {
    client: { space: () => ({ session: () => ({ turns: { listPaginated: () => new Promise(() => {}) } }) }) },
    openTokens: { current: new Map() },
    stateRef: { current: { sessions: [{ id: "session", spaceId: "space" }], spaces: [{ id: "space" }], sessionViews: { session: { messages: [], session: { id: "session", spaceId: "space" }, space: { id: "space" } } } } },
    dispatch: (action) => coldActions.push(action),
    loadMessages: async () => [],
    userKey: "test-user",
    recordSpaceVisit: () => {},
    attachSessionRealtime: () => {},
    refreshSession: async () => {},
    messagesFromTurns: () => [],
    isLiveMessage: () => false,
    mergeDisplayMessages: (messages) => messages,
    loadTurnIndex: async () => {},
    saveMessages: async () => {},
    markChatEntry: () => {},
    startChatEntry: () => {},
    translate: (key) => key,
    withTimeout: pageTimeout,
    displaySpaceName: (space) => space.name,
  };
  const cold = new Function(...Object.keys(coldScope), ts.transpileModule(`return (${reopenSource});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(coldScope));
  const pendingCold = cold("session");
  await flushSync();
  mock.timers.tick(15000);
  await pendingCold;
  assert.equal(coldActions.at(-1).type, "session-error", "a stalled cold history request must fail instead of hanging the Chat");
  assert.match(coldActions.at(-1).message, /Timed out/);
} finally {
  mock.timers.reset();
}

const preferenceSource = ts.transpileModule(readFileSync(new URL("../src/data/session-filter-preference.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function loadPreferenceModule(storage) {
  const exports = {};
  new Function("require", "exports", preferenceSource)((name) => {
    if (name === "@react-native-async-storage/async-storage") return storage;
    if (name === "./session-status") return { DEFAULT_SESSION_FILTER_MINUTES, parseSessionFilterMinutes };
    if (name === "react") return {};
    throw new Error(`Unexpected preference dependency: ${name}`);
  }, exports);
  return exports;
}
let storedFilterMinutes = null;
let rejectPreferenceWrite = false;
const filterStorage = {
  getItem: async () => storedFilterMinutes,
  setItem: async (_key, value) => {
    if (rejectPreferenceWrite) throw new Error("Storage unavailable");
    storedFilterMinutes = value;
  },
};
const filterPreference = loadPreferenceModule(filterStorage);
assert.equal(await filterPreference.loadSessionFilterMinutes(), 30, "missing preference defaults to 30 minutes");
await filterPreference.saveSessionFilterMinutes(45);
assert.equal(storedFilterMinutes, "45");
assert.equal(await filterPreference.loadSessionFilterMinutes(), 45);
assert.equal(await loadPreferenceModule(filterStorage).loadSessionFilterMinutes(), 45, "a new module instance restores the saved window");
rejectPreferenceWrite = true;
await assert.rejects(filterPreference.saveSessionFilterMinutes(90), /Storage unavailable/);
assert.equal(await filterPreference.loadSessionFilterMinutes(), 45, "failed saves do not replace the active preference");
await assert.rejects(filterPreference.saveSessionFilterMinutes(0), /whole number/);
let finishPreferenceRead;
const concurrentPreference = loadPreferenceModule({ ...filterStorage, getItem: () => new Promise((resolve) => { finishPreferenceRead = resolve; }), setItem: async () => {} });
const pendingPreferenceRead = concurrentPreference.loadSessionFilterMinutes();
await concurrentPreference.saveSessionFilterMinutes(90);
finishPreferenceRead("15");
assert.equal(await pendingPreferenceRead, 90, "a late stored snapshot cannot overwrite a user save");
const invalidPreference = loadPreferenceModule({ ...filterStorage, getItem: async () => "30minutes" });
await assert.rejects(invalidPreference.loadSessionFilterMinutes(), /whole number/);

let storedSource = null;
const sourceStorage = { getItem: async () => storedSource, setItem: async (_key, value) => { storedSource = value; } };
const sourcePreference = loadPreferenceModule(sourceStorage);
assert.equal(await sourcePreference.loadSessionSourcePreference(), "all", "missing source preference defaults to all");
assert.equal(sourcePreference.parseSessionSourceFilter("web"), "web");
assert.equal(sourcePreference.parseSessionSourceFilter("nonsense"), "all");
await sourcePreference.saveSessionSourcePreference("other");
assert.equal(storedSource, "other");
assert.equal(await sourcePreference.loadSessionSourcePreference(), "other");
assert.equal(await loadPreferenceModule(sourceStorage).loadSessionSourcePreference(), "other", "a new module instance restores the saved source");
let finishSourceRead;
const concurrentSource = loadPreferenceModule({ ...sourceStorage, getItem: () => new Promise((resolve) => { finishSourceRead = resolve; }), setItem: async () => {} });
const pendingSourceRead = concurrentSource.loadSessionSourcePreference();
await concurrentSource.saveSessionSourcePreference("web");
finishSourceRead("other");
assert.equal(await pendingSourceRead, "web", "a late stored snapshot cannot overwrite a user source save");

const statusCalls = [];
const statusResults = new Map();
const recentSession = { spaceId: "space1", lastMessageAt: new Date().toISOString() };
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
assert.equal(maxInFlightStatuses, 2);
assert.equal(completedStatuses, 15);

let sharedRequests = 0;
let sharedRunning = 0;
let sharedPeak = 0;
const sharedStatusClient = { space: () => ({ session: () => ({ turns: { listPaginated: async () => {
  sharedRequests++;
  sharedRunning++;
  sharedPeak = Math.max(sharedPeak, sharedRunning);
  await new Promise((resolve) => setTimeout(resolve, 0));
  sharedRunning--;
  return { turns: [runningTurn] };
} } }) }) };
const sharedSessions = Array.from({ length: 4 }, (_, id) => ({ ...recentSession, id: `shared-${id}` }));
await Promise.all([
  loadSessionLatestTurns(sharedStatusClient, sharedSessions, () => {}),
  loadSessionLatestTurns(sharedStatusClient, sharedSessions.slice(0, 2), () => {}),
]);
assert.equal(sharedRequests, 4, "overlapping screen/status refreshes share per-session requests");
assert.equal(sharedPeak, 2, "the status concurrency limit is shared across batches");
await loadSessionLatestTurns(sharedStatusClient, sharedSessions, () => {}, 30, { cached: true });
assert.equal(sharedRequests, 4, "unchanged outcomes are reused during automatic list polling");
await loadSessionLatestTurns(sharedStatusClient, sharedSessions, () => {}, 30, { shouldContinue: () => false });
assert.equal(sharedRequests, 4, "account disposal/background stops the remaining status batch");
for (let round = 0; round < 3; round++) {
  await Promise.all([
    loadSessionLatestTurns(sharedStatusClient, sharedSessions, () => {}),
    loadSessionLatestTurns(sharedStatusClient, sharedSessions.slice(2), () => {}),
  ]);
}
assert.equal(sharedPeak, 2, "repeated waiter handoffs retain the shared concurrency limit");

const oldActiveReads = [];
const oldActiveSession = { id: "old-chat", spaceId: "space", lastMessageAt: "2020-01-01T00:00:00Z", activeTurn: { id: "old-turn" } };
const oldActiveClient = { space: () => ({ session: () => ({ turns: {
  get: async (id) => { oldActiveReads.push(id); return { turn: { ...completedTurn, id } }; },
  listPaginated: () => assert.fail("An old known execution must be checked by turn ID"),
} }) }) };
await loadSessionLatestTurns(oldActiveClient, [oldActiveSession], () => {}, 30, { activeOnly: true });
assert.deepEqual(oldActiveReads, ["old-turn"], "active executions outside the recency window remain tracked");
await loadSessionLatestTurns(oldActiveClient, [oldActiveSession], () => {}, 30, {
  activeOnly: true,
  knownTurns: { "old-chat": { ...runningTurn, id: "new-turn" } },
  turnStatuses: { "old-turn": { ...completedTurn, id: "old-turn" } },
});
assert.deepEqual(oldActiveReads, ["old-turn", "new-turn"], "a stale active snapshot must not prevent checking the newer running turn");

const activeTasks = Array.from({ length: 105 }, (_, id) => ({ id: `task-${id}`, status: "running", createdAt: new Date(id * 1000).toISOString(), updatedAt: new Date(id * 1000).toISOString() }));
const taskBatches = [];
const nextTasks = await refreshTaskRuns({ tasks: {
  list: async () => ({ runs: [{ ...activeTasks[0], status: "completed", updatedAt: new Date(200000).toISOString() }] }),
  getMany: async (ids) => { taskBatches.push(ids); return { runs: ids.map((id) => ({ ...activeTasks.find((task) => task.id === id), status: "completed", updatedAt: new Date(200000).toISOString() })) }; },
} }, "space", activeTasks);
assert.deepEqual(taskBatches.map((batch) => batch.length), [100, 4]);
assert.equal(new Set(nextTasks.map((task) => task.id)).size, 105, "known active tasks outside the first page are not dropped");
const mergedTasks = mergeTaskRuns(activeTasks, nextTasks);
assert.ok(mergedTasks.every((task) => task.status === "completed"));
assert.equal(mergeTaskRuns(mergedTasks, activeTasks)[0].status, "completed", "late task pages cannot undo a newer status");
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
assert.equal(sessionSourceFilterKeys("all"), null);
assert.deepEqual(sessionSourceFilterKeys("web"), ["web"]);
assert.ok(sessionSourceFilterKeys("other")?.includes("other"));
assert.ok(!sessionSourceFilterKeys("other")?.includes("web"));
assert.deepEqual(toUserSessionLabels([
  { id: "src", name: "Source", source: "system", systemKey: null, children: [{ id: "web", name: "Web App", source: "system", systemKey: "session-source:web", children: [] }] },
  { id: "work", name: "Work", source: "user", systemKey: null, children: [{ id: "urgent", name: "Urgent", source: "user", systemKey: null, children: [] }] },
]).map((label) => label.ref), ["Work/Urgent", "Work"]);
assert.equal(normalizeSearchQuery("  server   result  "), "server result");
assert.equal(isResourcePinned([{ labelSystemKey: "user:pinned" }]), true);
assert.equal(isResourcePinned([{ labelSystemKey: "other" }]), false);
const listNow = Date.parse("2026-09-11T12:00:00Z");
const spaceListInput = {
  spaces: [{ id: "old", updatedAt: "2026-01-01", isPinned: true }, { id: "new", updatedAt: "2026-09-11" }],
  sessions: [{ spaceId: "old", lastMessageAt: "2026-09-11T11:00:00Z" }],
  overview: { spaces: [{ id: "new", lastParticipatedAt: null }, { id: "old", lastParticipatedAt: "2026-09-10" }] },
  visits: [], personalActivity: new Map(), now: listNow,
};
const spaceIds = (options) => selectSpaceList({ ...spaceListInput, ...options }).map((space) => space.id);
assert.deepEqual(spaceIds({ filter: "recent" }), ["old", "new"], "Recent uses personal participation, not Space updatedAt");
assert.deepEqual(spaceIds({ filter: "all" }), ["old", "new"], "All includes session activity");
assert.deepEqual(spaceIds({ filter: "pinned" }), ["old"]);
assert.deepEqual(spaceIds({ filter: "recent", visits: [{ spaceId: "new", timestamp: listNow }] }), ["new", "old"]);
assert.deepEqual(spaceIds({ filter: "recent", personalActivity: new Map([["new", listNow]]) }), ["new", "old"]);
assert.deepEqual(spaceIds({ filter: "recent", overview: null }), [], "No server or cached overview is not a fabricated recent list");
assert.equal(recentSpaceVisits(Array.from({ length: 12 }, (_, i) => ({ spaceId: String(i), timestamp: listNow - i })), listNow).length, 10);
assert.deepEqual(recentSpaceVisits([{ spaceId: "expired", timestamp: listNow - SPACE_VISIT_MAX_AGE_MS - 1 }], listNow), []);
assert.throws(() => recentSpaceVisits([{ spaceId: "", timestamp: listNow }], listNow), /Invalid Space visit/);

mock.timers.enable({ apis: ["setTimeout"] });
try {
  let loads = 0;
  const releases = [];
  const lifecycle = createSessionLifecycle({ load: async () => { loads += 1; }, release: (id) => releases.push(id), releaseDelayMs: 1000 });
  await lifecycle.open("running");
  for (let i = 0; i < 100; i += 1) {
    lifecycle.close("running");
    mock.timers.tick(100);
    await lifecycle.open("running");
  }
  assert.equal(loads, 1, "Rapid navigation reuses one load and live subscription");
  assert.deepEqual(releases, []);
  await lifecycle.open("running");
  lifecycle.close("running");
  mock.timers.tick(1001);
  assert.deepEqual(releases, [], "Another reader still owns the stream");
  lifecycle.close("running");
  mock.timers.tick(1000);
  assert.deepEqual(releases, ["running"]);
  await lifecycle.open("running");
  assert.equal(loads, 2, "A released session reconciles when reopened");
  lifecycle.close("running");
  lifecycle.clear();
  mock.timers.tick(1000);
  assert.deepEqual(releases, ["running", "running"], "Account cleanup releases once and cancels timers");

  let primedLoads = 0;
  const primedReleases = [];
  const primed = createSessionLifecycle({ load: async () => { primedLoads += 1; }, release: (id) => primedReleases.push(id), releaseDelayMs: 1000 });
  primed.prime("warm");
  primed.prime("warm");
  assert.equal(primedLoads, 1, "press-in prefetch shares one load");
  await primed.open("warm");
  assert.equal(primedLoads, 1, "opening a primed Chat reuses the in-flight load");
  mock.timers.tick(1000);
  assert.deepEqual(primedReleases, [], "an owned Chat does not release on the prefetch timer");
  primed.close("warm");
  mock.timers.tick(1000);
  assert.deepEqual(primedReleases, ["warm"]);
  primed.prime("cancel");
  mock.timers.tick(1000);
  assert.deepEqual(primedReleases, ["warm", "cancel"], "a cancelled press-in still releases");
} finally {
  mock.timers.reset();
}
assert.equal(panelForScrollOffset(0, 360, 760), "chat");
assert.equal(panelForScrollOffset(360, 360, 760), null);
assert.equal(panelForScrollOffset(760, 360, 760), "files");
assert.equal(panelForScrollOffset(150, 360, 760), "chat");
assert.equal(panelForScrollOffset(620, 360, 760), "files");

// Filter touches re-render the pager to toggle scrollEnabled. Reapplying a closed-page
// contentOffset can reset the native scroll position even though no close was requested.
const panelsSource = ts.createSourceFile("SpacePanels.tsx", readFileSync(new URL("../src/components/SpacePanels.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let panelPager;
function findPanelPager(node) {
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(panelsSource) === "Reanimated.ScrollView") panelPager = node;
  ts.forEachChild(node, findPanelPager);
}
findPanelPager(panelsSource);
assert.ok(panelPager, "Space panels retain their native scroll pager");
const pagerAttributes = panelPager.attributes.properties.filter(ts.isJsxAttribute);
assert.equal(pagerAttributes.some((attribute) => attribute.name.getText(panelsSource) === "contentOffset"), false, "Filter touch re-renders must not reapply the closed-page contentOffset");
assert.equal(panelPager.attributes.properties.filter(ts.isJsxSpreadAttribute).some((spread) => spread.getText(panelsSource).includes("contentOffset")), false, "Spreading contentOffset and then dropping it resets the pager onto the Chats page");
// Render the real pager with native commands delayed until both layouts are ready.
// This checks geometry and callback ordering, not Android rendering or Reanimated scheduling.
function panelPagerHarness(initialPanel = null) {
  const slots = [];
  let cursor = 0;
  const effects = [];
  let viewportWidth = 400;
  const commits = [];
  let props = { spaceId: "space", spaceName: "Space", sessions: [], client: null, activePanel: initialPanel, onActivePanelChange: (panel) => { commits.push(panel); props = { ...props, activePanel: panel }; }, children: { type: "ChatContent" } };
  let measuredViewport = false;
  let measuredContent = false;
  let nativeX = 0;
  const commands = [];
  const slot = (create) => { const index = cursor++; if (!(index in slots)) slots[index] = create(); return [index, slots[index]]; };
  const effect = (callback, deps) => {
    const [index, previous] = slot(() => null);
    if (!previous || deps.some((value, index) => value !== previous[index])) { effects.push(callback); slots[index] = deps; }
  };
  const renderPanels = loadChromeComponent("../src/components/SpacePanels.tsx", "SpacePanels", {
    ...chromeScope,
    useState: (initial) => { const [index, value] = slot(() => typeof initial === "function" ? initial() : initial); return [value, (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
    useRef: (initial) => slot(() => ({ current: initial }))[1],
    useSharedValue: (initial) => slot(() => ({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }))[1],
    useEffect: effect, useLayoutEffect: effect,
    useCallback: (callback, deps) => {
      const [index, previous] = slot(() => null);
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useMemo: (factory, deps) => {
      const [index, previous] = slot(() => null);
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
    useWindowDimensions: () => ({ width: viewportWidth }), useSafeAreaInsets: () => ({ top: 0, bottom: 0 }), useIsFocused: () => true,
    useAnimatedScrollHandler: (handler) => handler, useAnimatedStyle: (style) => ({ animated: style }),
    scheduleOnRN: (callback, ...args) => callback(...args),
    interpolate: (value, input, output) => Math.min(output[1], Math.max(output[0], value / input[1])), Extrapolation: { CLAMP: "clamp" },
    Reanimated: { ScrollView: "Pager", View: "AnimatedView" }, BackHandler: { addEventListener: () => ({ remove() {} }) },
    PANEL_WIDTH_RATIO: 0.86, MAX_PANEL_WIDTH: 360, PANEL_SCROLL_IDLE_MS: 140, PANEL_CLOSE_SETTLE_MS: 380,
    PANEL_SEED_RETRY_MS: 240, PANEL_SEED_FORCE_MS: 480,
    panelForScrollOffset, chatScrollTrace: { record() {} }, ChatPanel: "ChatPanel", FilesPanel: "FilesPanel",
  });
  let tree;
  const render = () => {
    cursor = 0;
    tree = renderPanels(props);
    const pager = chromeNodes(tree).find((node) => node.type === "Pager");
    pager.props.ref.current = { scrollTo: (command) => { commands.push(command); if (measuredContent && measuredViewport) nativeX = Math.max(0, Math.min(command.x, 2 * Math.min(360, Math.max(280, viewportWidth * 0.86)))); } };
    while (effects.length) effects.shift()();
    return pager;
  };
  let pager = render();
  const content = (contentWidth = 2 * Math.min(360, Math.max(280, viewportWidth * 0.86)) + viewportWidth) => { measuredContent = true; pager.props.onContentSizeChange(contentWidth, 800); };
  const layout = (height = 800) => { measuredViewport = height > 0; pager.props.onLayout?.({ nativeEvent: { layout: { width: viewportWidth, height } } }); };
  const style = (node) => Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean).map((value) => value.animated ? value.animated() : value));
  return {
    commands, commits, content, layout,
    resize: (width) => { viewportWidth = width; measuredContent = measuredViewport = false; pager = render(); },
    nodes: () => chromeNodes(tree),
    render: () => (pager = render()),
    nativeX: () => nativeX,
    pager: () => pager,
    paintCoverage: () => {
      const shift = style(pager).transform?.[0]?.translateX ?? 0;
      return Math.max(0, Math.min(viewportWidth, shift + viewportWidth) - Math.max(0, shift));
    },
    contentShift: () => style(pager.props.children[0]).transform?.[0]?.translateX ?? 0,
    scroll: (x) => { nativeX = x; pager.props.onScroll.onScroll({ contentOffset: { x } }); },
    setPanel: (panel) => { props = { ...props, activePanel: panel }; return (pager = render()); },
  };
}
const clippedPager = panelPagerHarness();
assert.equal(clippedPager.paintCoverage(), 400, "initial seeding must not translate/clip the viewport down to the 14% Chat strip seen in the report");
for (const order of ["content-first", "viewport-first"]) {
  const harness = panelPagerHarness();
  if (order === "content-first") { harness.content(); harness.layout(); }
  else { harness.layout(); harness.content(); }
  assert.equal(harness.nativeX(), 344, `${order}: seed only after both viewport and content can accept scrollTo`);
  harness.scroll(344);
  harness.render();
  assert.equal(harness.paintCoverage(), 400);
  assert.equal(harness.contentShift(), 0, "native acknowledgement removes content-only compensation");
}
const delayedPager = panelPagerHarness();
assert.ok(delayedPager.nodes().some((node) => node.type === "ChatPanel"), "Chats are mounted before the first swipe reveals them");
assert.ok(delayedPager.nodes().some((node) => node.type === "FilesPanel"), "Files are mounted and start loading before the first swipe reveals them");
assert.equal(delayedPager.pager().props.scrollEnabled, false, "unseeded native pages cannot be dragged into view");
assert.equal(delayedPager.contentShift(), -344, "only the page strip compensates for native offset zero");
delayedPager.scroll(0);
delayedPager.pager().props.onMomentumScrollEnd();
assert.deepEqual(delayedPager.commits, [], "pre-layout scroll/end events cannot commit a phantom open panel");
delayedPager.content();
delayedPager.layout(0);
assert.equal(delayedPager.commands.length, 0, "zero-height route-transition layouts cannot complete seeding");
delayedPager.layout();
delayedPager.render();
assert.equal(delayedPager.pager().props.scrollEnabled, false, "sending scrollTo is not acknowledgement");
delayedPager.pager().props.onScrollBeginDrag();
assert.equal(delayedPager.contentShift(), -344, "an early drag callback cannot drop the seed compensation");
delayedPager.scroll(344);
delayedPager.render();
assert.equal(delayedPager.pager().props.scrollEnabled, true);
const commandsAfterSeed = delayedPager.commands.length;
delayedPager.content();
delayedPager.layout();
delayedPager.render();
assert.equal(delayedPager.commands.length, commandsAfterSeed, "stream/list re-layouts never reposition a ready pager");
for (let cycle = 0; cycle < 2; cycle++) {
  delayedPager.pager().props.onScrollBeginDrag();
  delayedPager.scroll(688);
  delayedPager.pager().props.onMomentumScrollEnd();
  delayedPager.render();
  assert.ok(delayedPager.nodes().some((node) => node.type === "FilesPanel"), "every repeated swipe reveals the preloaded Files panel");
  delayedPager.scroll(344);
  delayedPager.pager().props.onMomentumScrollEnd();
  delayedPager.render();
  assert.ok(delayedPager.nodes().some((node) => node.type === "FilesPanel"), "closing keeps Files warm for the next swipe");
}
delayedPager.setPanel("chat");
assert.deepEqual(delayedPager.commands.at(-1), { x: 0, animated: true }, "external menu commands still open the requested panel");
delayedPager.scroll(0);
delayedPager.pager().props.onMomentumScrollEnd();
delayedPager.render();
assert.ok(delayedPager.nodes().some((node) => node.type === "ChatPanel"));
delayedPager.setPanel(null);
delayedPager.scroll(344);
delayedPager.pager().props.onMomentumScrollEnd();
delayedPager.render();
delayedPager.resize(800);
delayedPager.content();
delayedPager.layout();
assert.equal(delayedPager.nativeX(), 360, "resize uses current native layout dimensions");
delayedPager.scroll(360);
delayedPager.render();
delayedPager.resize(900);
delayedPager.layout();
delayedPager.content();
delayedPager.render();
assert.equal(delayedPager.pager().props.scrollEnabled, true, "a capped-width panel can retain its confirmed offset across resize without a new scroll event");
assert.equal(delayedPager.paintCoverage(), 900);
for (const [initialPanel, offset] of [["chat", 0], ["files", 688]]) {
  const harness = panelPagerHarness(initialPanel);
  harness.scroll(0);
  harness.content();
  harness.layout();
  assert.equal(harness.nativeX(), offset, "mounting with a panel open seeds that panel, not the center");
  assert.equal(harness.commands.at(-1).x, offset, "right-panel targets must be reachable without native scroll clamping");
  harness.scroll(offset);
  harness.render();
  assert.equal(harness.pager().props.scrollEnabled, true);
}
// The seed depends on one native scroll event; when the first chat frame swallows it, the
// fallback must re-send and then force-complete, or the panel swipe stays dead for the screen.
{
  const timer = mock.timers;
  // Arm inside the mocked clock: timers registered before enable() are not intercepted.
  timer.enable({ apis: ["setTimeout"], now: 50_000 });
  try {
    const swallowedSeed = panelPagerHarness();
    swallowedSeed.content();
    swallowedSeed.layout();
    assert.equal(swallowedSeed.pager().props.scrollEnabled, false, "the seed still waits for acknowledgement before enabling the gesture");
    const commandsBeforeRetry = swallowedSeed.commands.length;
    timer.tick(240);
    swallowedSeed.render();
    assert.ok(swallowedSeed.commands.length > commandsBeforeRetry, "a swallowed seed acknowledgement is re-issued once");
    assert.equal(swallowedSeed.pager().props.scrollEnabled, false, "the retry alone cannot mark the pager ready");
    timer.tick(480);
    swallowedSeed.render();
    assert.equal(swallowedSeed.pager().props.scrollEnabled, true, "a second unacknowledged seed force-completes instead of deadlocking the gesture");
    assert.equal(swallowedSeed.contentShift(), 0, "forcing the seed drops the stale page-strip compensation");
    swallowedSeed.scroll(344);
    swallowedSeed.render();
    assert.equal(swallowedSeed.pager().props.scrollEnabled, true, "the pager stays usable after a forced seed");
  } finally { timer.reset(); }
}
const closingSeed = panelPagerHarness("files");
closingSeed.content();
closingSeed.layout();
const seedFilesPanel = closingSeed.nodes().find((node) => node.type === "FilesPanel");
seedFilesPanel.props.onClose();
closingSeed.render();
assert.equal(closingSeed.nativeX(), 344);
assert.ok(closingSeed.nodes().some((node) => node.type === "FilesPanel"), "closing before seed acknowledgement keeps the preloaded panel mounted");
closingSeed.scroll(344);
closingSeed.render();
assert.equal(closingSeed.pager().props.scrollEnabled, true);
assert.ok(panelsSource.text.includes("pagerSeed"), "The first paint must compensate until native scroll reaches the closed page");
assert.equal(panelsSource.text.includes("activePanelRef.current ?? visiblePanelRef.current"), false, "width realignment must not follow a pre-seed visiblePanel onto the Chats page");
assert.ok(pagerAttributes.some((attribute) => attribute.name.getText(panelsSource) === "onContentSizeChange"), "The pager still initializes its position on first layout");
assert.equal(panelsSource.text.includes("usePanelGestureBlocker"), false, "The pager must not be disabled for every message that happens to contain a fence");
const markdownPatch = readFileSync(new URL("../scripts/patch-enriched-markdown.mjs", import.meta.url), "utf8");
assert.ok(markdownPatch.includes("NestedHorizontalScrollView"), "Code-block scrolling must use a nested HorizontalScrollView that can claim the drag");
assert.ok(markdownPatch.includes("dispatchTouchEvent"), "Code-block scrolling must claim in dispatchTouchEvent; OnTouchListener never sees ACTION_DOWN");
assert.equal(markdownPatch.includes("setOnTouchListener {"), false, "OnTouchListener never sees ACTION_DOWN once the code TextView consumes it");
const messageContent = readFileSync(new URL("../src/components/MessageContent.tsx", import.meta.url), "utf8");
assert.equal(messageContent.includes("usePanelGestureBlocker"), false, "Message markdown must not blanket-block the panel swipe");
assert.equal(messageContent.includes("holdsPanelGesture"), false, "Message markdown must not blanket-block the panel swipe");
assert.ok(panelsSource.text.includes("prefetchSession"), "opening a Chat from the space panel starts the load on press-in");
assert.ok(readFileSync(new URL("../app/(tabs)/index.tsx", import.meta.url), "utf8").includes("prefetchSession"), "opening a Chat from Chats starts the load on press-in");
assert.match(readFileSync(new URL("../src/data/context.tsx", import.meta.url), "utf8"), /useLayoutEffect\(\(\) => \{\s*void openSession\(sessionId\);/, "Chat open must attach before paint so a prefetch can win the first frame");

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
assert.equal(getComposerLayout({ ...composerLayoutInput, contentHeight: 52, expanded: true }).height, 320, "an expanded editor keeps its height even when the content fits");
assert.equal(getComposerLayout({ ...composerLayoutInput, contentHeight: 52, expanded: true }).scrollEnabled, true, "an expanded editor stays scrollable because the estimate may undershoot real wraps");
assert.equal(getComposerLayout({ ...composerLayoutInput, expanded: true }).showExpandButton, true, "collapse remains available after deleting back to one line");
assert.deepEqual(getComposerLayout({ ...composerLayoutInput, text: "", contentHeight: 600, expanded: true }), {
  expanded: false, showExpandButton: false, height: 44, scrollEnabled: false,
}, "clearing or sending resets the layout even before the native measurement catches up");
assert.equal(getComposerLayout({ ...composerLayoutInput, availableHeight: 400, expanded: true }).height, 180, "expanded input leaves room above the keyboard");
assert.equal(getComposerLayout({ ...composerLayoutInput, availableHeight: 180, contentHeight: 600 }).height, 81, "short viewports also constrain the default input");
assert.equal(getComposerLayout({ ...composerLayoutInput, lineHeight: 44, contentHeight: 52 }).showExpandButton, false, "a large-font single line is not mistaken for multiline");
assert.equal(getComposerLayout({ ...composerLayoutInput, lineHeight: 44, contentHeight: 96 }).showExpandButton, true);
assert.equal(getComposerLayout({ ...composerLayoutInput, lineHeight: 44, contentHeight: 52 }).height, 52);
// A dictation final can land after the mic already stopped, so auto-expansion keys off the
// JS-driven append (no onChangeText round-trip), not off active recording.
const autoExpandInput = { value: "hello", expanded: false, scrollEnabled: true, lastUserText: "hello", autoExpandedFor: null };
assert.equal(shouldAutoExpandComposer(autoExpandInput), false, "user-typed text never auto-expands");
assert.equal(shouldAutoExpandComposer({ ...autoExpandInput, value: "a very long dictation transcript" }), true, "a JS-appended overflowing transcript expands even after the mic stopped");
assert.equal(shouldAutoExpandComposer({ ...autoExpandInput, value: "a very long dictation transcript", scrollEnabled: false }), false, "a short append that fits the collapsed box stays collapsed");
assert.equal(shouldAutoExpandComposer({ ...autoExpandInput, value: "a very long dictation transcript", autoExpandedFor: "a very long dictation transcript" }), false, "the append expands once so a manual collapse sticks while the transcript is reviewed");
assert.equal(shouldAutoExpandComposer({ ...autoExpandInput, value: "first sentence. a longer final sentence.", lastUserText: "first sentence.", autoExpandedFor: "first sentence." }), true, "the next dictation final re-arms the expansion");
assert.equal(shouldAutoExpandComposer({ ...autoExpandInput, value: "a very long dictation transcript", expanded: true }), false, "an already-expanded editor needs no expansion");
// Android's stale-watcher deadlock: a JS-driven final leaves the native measurement stale, so
// the text-derived estimate must expose the overflow and raise the collapsed height on its own.
const lineHeight = 22;
assert.equal(estimateComposerContentHeight("", lineHeight), 0, "empty text measures nothing");
assert.equal(estimateComposerContentHeight("word ".repeat(45), lineHeight), 7 * lineHeight + COMPOSER_TEXT_PADDING, "the estimate wraps long prose into multiple lines");
assert.equal(estimateComposerContentHeight("这是一段比较长的中文语音转写内容，".repeat(6), lineHeight), 6 * lineHeight + COMPOSER_TEXT_PADDING, "CJK glyphs count double so Chinese lines are not under-counted");
assert.equal(estimateComposerContentHeight("a\nb\nc", lineHeight), 3 * lineHeight + COMPOSER_TEXT_PADDING, "explicit newlines each take a line");
assert.equal(estimateComposerContentHeight("a very long dictation transcript", lineHeight), lineHeight + COMPOSER_TEXT_PADDING, "a short append still estimates one line");
assert.equal(getComposerLayout({ text: "word ".repeat(45), contentHeight: Math.max(30, estimateComposerContentHeight("word ".repeat(45), lineHeight)), lineHeight, availableHeight: 800, expanded: false }).scrollEnabled, true, "the estimate alone unsticks the overflow signal when the native measurement is stale");
assert.equal(getComposerLayout({ text: "word ".repeat(45), contentHeight: Math.max(30, estimateComposerContentHeight("word ".repeat(45), lineHeight)), lineHeight, availableHeight: 800, expanded: false }).height, 120, "the estimated overflow still respects the collapsed height cap");
assert.equal(COMPOSER_CHROME_HEIGHT, 132);
assert.equal(collapsedComposerHeight(34), 166);
assert.equal(collapsedComposerHeight(0), 132);
assert.equal(collapsedComposerHeight(-1), 132);
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
// Growth (or an animated programmatic pin) must not read as the user scrolling away.
assert.equal(chatTailScrolledAway({ dragging: false, momentum: false, contentGrew: false, offsetDelta: 0 }), false);
assert.equal(chatTailScrolledAway({ dragging: true, momentum: false, contentGrew: false, offsetDelta: -40 }), true);
assert.equal(chatTailScrolledAway({ dragging: false, momentum: true, contentGrew: false, offsetDelta: -40 }), true);
assert.equal(chatTailScrolledAway({ dragging: false, momentum: true, contentGrew: true, offsetDelta: -40 }), false, "a streamed burst keeps the tail");
assert.equal(chatTailScrolledAway({ dragging: true, momentum: true, contentGrew: true, offsetDelta: -40 }), false, "growth under the finger still keeps the tail");
assert.equal(chatTailScrolledAway({ dragging: false, momentum: true, contentGrew: false, offsetDelta: 80 }), false, "the animated pin catching up is not a scroll-away");
assert.equal(chatTailScrolledAway({ dragging: true, momentum: true, contentGrew: false, offsetDelta: 80 }), false, "a programmatic pin must not look like a drag-away");
assert.equal(chatTailScrolledAway({ dragging: true, momentum: false, contentGrew: false, offsetDelta: 0 }), false, "holding still at the tail is not leaving");
assert.equal(chatFollowPinAnimated(0), true);
assert.equal(chatFollowPinAnimated(CHAT_FOLLOW_TAIL_ANIMATE_THRESHOLD), true);
assert.equal(chatFollowPinAnimated(CHAT_FOLLOW_TAIL_ANIMATE_THRESHOLD + 1), false, "a burst larger than the pin window snaps instead of chasing");
assert.equal(chatFollowPinAnimated(CHAT_FOLLOW_TAIL_ANIMATE_THRESHOLD, false), false, "stay snapped until back on the tail");
assert.equal(chatFollowPinAnimated(CHAT_TAIL_THRESHOLD, false), true);
assert.equal(chatFollowPinAnimated(CHAT_TAIL_THRESHOLD + 1, false), false);
assert.equal(chatTailStalled(0, true), false, "on the tail with a frozen pin is fine");
assert.equal(chatTailStalled(CHAT_FOLLOW_TAIL_ANIMATE_THRESHOLD, true), false, "a gap inside the pin window still animates");
assert.equal(chatTailStalled(CHAT_FOLLOW_TAIL_ANIMATE_THRESHOLD + 1, true), true, "a frozen pin with an outgrown gap must recover");
assert.equal(chatTailStalled(CHAT_FOLLOW_TAIL_ANIMATE_THRESHOLD + 1, false), false, "a moving pin is catching up, not stalled");
assert.deepEqual(chatMaintainScrollAtEnd(true), { animated: true }, "sending must not disable the moving tail");
assert.deepEqual(chatMaintainScrollAtEnd(true, false), { animated: false }, "first-row measurement and reduced motion must not animate the pin");
assert.equal(chatMaintainScrollAtEnd(false), false);
const sendRect = { x: 10, y: 20, width: 100, height: 40 };
assert.deepEqual(interpolateSendBubbleRect(sendRect, { x: 110, y: 220, width: 180, height: 60 }, 0.5), { x: 60, y: 120, width: 140, height: 50 });
assert.deepEqual(await measureSendBubbleSource({ measureInWindow: (callback) => callback(20, 30, 100, 40) }, { measureInWindow: (callback) => callback(5, 10, 300, 500) }, 6), { x: 15, y: 20, width: 100, height: 40, scrollY: 6 });
const sentMessage = { id: "local", sessionId: "session", role: "user", meta: { clientMessageId: "same" } };
assert.equal(isSendBubbleMessage({ ...sentMessage, id: "server", meta: { clientMessageId: "same" } }, sentMessage), true);
assert.ok(motion.sendBubble.duration < 500, "send bubble handoff stays within a short interaction window");
const renderSendOverlay = loadChromeComponent("../src/components/SendBubbleOverlay.tsx", "SendBubbleOverlay", {
  ...chromeScope,
  useAppTheme: () => ({ radius: { lg: 18 }, colors: {} }),
  Animated: { View: "AnimatedView" }, MessageBubble: "MessageBubble", QueuedFollowupRow: "QueuedFollowupRow", AttachmentChip: "AttachmentChip",
  useAnimatedRef: () => ({ current: null }), useSharedValue: (value) => ({ get: () => value }),
  useEffect: () => {}, useFrameCallback: () => {}, useAnimatedStyle: (callback) => callback(),
  interpolateSendBubbleRect, getBubbleMaxWidth, interpolate: () => 0, interpolateColor: () => "color", Extrapolation: { CLAMP: "clamp" },
});
for (const destination of ["bubble", "queue"]) {
  for (const attachments of [[], [{ uri: "file:///photo.png", name: "photo.png", mimeType: "image/png", size: 20 }], [{ uri: "file:///file.pdf", name: "file.pdf", mimeType: "application/pdf", size: 30 }]]) {
    const overlay = renderSendOverlay({
      transition: { message: sentMessage, text: attachments.length ? "" : "Hello", attachments, source: { ...sendRect, scrollY: 0 }, destination },
      message: sentMessage, queueItem: destination === "queue" ? { preview: "Queued", turn: null } : null,
      rootRef: {}, targetRef: {}, availableWidth: 390, spaceId: "space", onComplete: () => {},
    });
    const nodes = chromeNodes(overlay);
    assert.equal(nodes.filter((node) => node.type === "MessageBubble").length, destination === "bubble" ? 1 : 0, "queue animations must never render a bubble copy");
    assert.equal(nodes.filter((node) => node.type === "QueuedFollowupRow").length, destination === "queue" ? 1 : 0);
    assert.equal(nodes.filter((node) => node.type === "AttachmentChip").length, attachments.length, "attachment sources keep their visible file/image previews");
  }
}
// An unmounted destination row makes Reanimated's measure throw. Worklets does not catch an
// exception raised inside a UI-thread frame callback, so a throw here would abort the process
// (the 2.2.12 send-bubble crash): an unmeasurable view must read as not ready instead.
const measureView = loadChromeComponent("../src/components/SendBubbleOverlay.tsx", "measureView", {
  ...chromeScope,
  measure: () => { throw new Error("Value is null, expected an Object"); },
});
assert.equal(measureView({}), null, "an unattached destination ref is not ready, not fatal");
const measuredRect = { x: 1, y: 2, width: 3, height: 4, pageX: 5, pageY: 6 };
const measureMountedView = loadChromeComponent("../src/components/SendBubbleOverlay.tsx", "measureView", { ...chromeScope, measure: () => measuredRect });
assert.deepEqual(measureMountedView({}), measuredRect, "a mounted view still reports its measurement");
assert.ok(CHAT_FOLLOW_TAIL_MAINTAIN_THRESHOLD >= 1, "a streamed card can grow more than 10% of the screen in one layout");
assert.ok(CHAT_FOLLOW_TAIL_ANIMATE_THRESHOLD > CHAT_TAIL_THRESHOLD, "the smooth pin has room to catch a few lines before snapping");
const chatSource = readFileSync(new URL("../app/chat/[sessionId].tsx", import.meta.url), "utf8");
assert.ok(chatSource.includes("offsetDelta"), "the pin catching up is distinguished from scrolling toward older messages");
assert.ok(chatSource.includes("chatTailStalled"), "content growth must run the stall fallback so an opened-while-streaming chat recovers without a manual nudge");
assert.ok(chatSource.includes("chatFollowPinAnimated"), "a burst larger than the pin window must snap");
const runningRowMessages = [
  { id: "user-a", role: "user", meta: { turnId: "turn-a", turnSequence: 1 } },
  { id: "queued-b", role: "user", meta: { optimistic: true, turnSequence: 2 } },
];
assert.equal(liveReplyAnchor(runningRowMessages, "turn-a"), "user-a", "a queued send must not take ownership of the running turn's reply");
assert.equal(liveReplyAnchor(runningRowMessages, null), "queued-b", "a send without a turn id follows its optimistic user row");
assert.equal(liveReplyAnchor([], "turn-a"), null);
assert.equal(liveReplyAnchor(runningRowMessages, "not-yet-loaded"), "queued-b", "unloaded history retains the live reply at the loaded tail");

// Execute the production renderItem: the reply must be a normal-flow sibling of
// the user bubble inside the SAME measured row, including after tool expansion.
const chatAst = ts.createSourceFile("chat.tsx", chatSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let renderMessageSource;
function findChatRender(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(chatAst) === "renderMessage") renderMessageSource = node.initializer.arguments[0].getText(chatAst);
  ts.forEachChild(node, findChatRender);
}
findChatRender(chatAst);
const liveRowScope = {
  ...chromeScope, messages: runningRowMessages, sendTransition: null, replyAnchor: "user-a", liveStream: true,
  turnSequenceForMessage: (message) => message.meta?.turnSequence ?? null,
  turnIndexBySequence: new Map(), turnsById: new Map(), turnsBySequence: new Map(),
  chatScrollTrace: { isRecording: () => false }, trackRow: () => {},
  MessageBubble: "MessageBubble", TurnMarker: "TurnMarker", LiveReply: "LiveReply",
  listWidth: 390, windowWidth: 390, sessionId: "fixture", spaceId: "space", streamTurnId: "turn-a",
  handleCopyMessage: () => {}, forkMessage: () => {}, forkingTurnId: null,
};
const renderLiveRow = new Function(...Object.keys(liveRowScope), ts.transpileModule(`return (${renderMessageSource});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(liveRowScope));
const ownerRow = renderLiveRow({ item: runningRowMessages[0], index: 0 });
assert.equal(ownerRow.type, "View");
assert.equal(typeof ownerRow.props.onLayout, "function");
assert.deepEqual(ownerRow.props.children.filter((child) => child?.type === "MessageBubble" || child?.type === "LiveReply").map((child) => child.type), ["MessageBubble", "LiveReply"]);
assert.equal(chromeNodes(renderLiveRow({ item: runningRowMessages[1], index: 1 })).filter((node) => node.type === "LiveReply").length, 0);
const liveView = { stream: { turnId: "turn", intermediateMessages: [] }, sending: false, messages: [] };
const renderLiveReply = loadChromeComponent("../app/chat/[sessionId].tsx", "LiveReply", {
  ...chromeScope, useApp: () => ({ state: { sessionViews: { fixture: liveView } } }),
  StreamingTurnProcess: "StreamingTurnProcess", StreamCard: "StreamCard", isOptimisticFollowup,
});
assert.equal(chromeNodes(renderLiveReply({ sessionId: "fixture", showStream: true, processInRow: true, availableWidth: 390 })).filter((node) => node.type === "StreamCard").length, 1);
assert.equal(renderLiveReply({ sessionId: "fixture", showStream: false, processInRow: true, availableWidth: 390 }), null, "completed replies leave no stale live duplicate");
liveView.sending = true;
assert.equal(renderLiveReply({ sessionId: "fixture", showStream: false, processInRow: false, availableWidth: 390 }).props.status, "pending");
const renderLiveProcess = loadChromeComponent("../app/chat/[sessionId].tsx", "LiveTurnProcess", {
  ...chromeScope,
  useApp: () => ({ state: { sessionViews: { fixture: { stream: { turnId: "turn", intermediateMessages: [] } } } } }),
  StreamingTurnProcess: "StreamingTurnProcess", TurnProcess: "TurnProcess",
});
const pendingProcess = renderLiveProcess({ sessionId: "fixture", turn: { id: "turn", intermediateSummary: { messageCount: 4, toolCallCount: 4 } }, client: null, spaceId: "space" });
assert.equal(pendingProcess.type, "TurnProcess", "reconnecting with an empty stream must not remove the cached execution summary and collapse its row");
assert.ok(!chatSource.includes('traceEnd("initial.latest"'), "Legend initialScrollAtEnd owns initial placement, without a competing app scroll");
assert.ok(!chatSource.includes("transition_cleanup_scheduled"), "animation completion, not a click-time timer, owns handoff");
assert.ok(!chatSource.includes("Keyboard.dismiss()"), "sending keeps the keyboard open");
assert.ok(chatSource.includes("hidden={isTransitionMessage}"), "the list reserves geometry without displaying a duplicate bubble");
assert.deepEqual(chatListDistances(0, 4000, 700), { distanceToLatest: 3300, distanceToOldest: 0 });
assert.deepEqual(chatListDistances(3280, 4000, 700), { distanceToLatest: 20, distanceToOldest: 3280 });

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

const apkOrigin = "https://mobile.talesofai.com";
const apkRelease = {
  version: "1.6.1",
  downloadUrl: androidUpdateApkUrl(apkOrigin, "1.6.1", "arm64-v8a"),
  downloadName: "cohub-v1.6.1-android-arm64-v8a.apk",
  downloadSize: 123,
  downloadSha256: "A".repeat(64),
};
for (const abi of ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]) {
  const name = `cohub-v1.6.1-android-${abi}.apk`;
  const url = androidUpdateApkUrl(apkOrigin, "1.6.1", abi);
  assert.deepEqual(validateAndroidUpdateAsset({ ...apkRelease, downloadName: name, downloadUrl: url }, apkOrigin), {
    name, url, size: 123, sha256: "a".repeat(64),
  });
}
for (const invalid of [
  { version: "1.6.1-beta" },
  { downloadUrl: "https://github.com/markbang/cohub-mobile/releases/download/v1.6.1/cohub-v1.6.1-android-arm64-v8a.apk" },
  { downloadUrl: apkRelease.downloadUrl.replace("https:", "http:") },
  { downloadUrl: `${apkRelease.downloadUrl}?redirect=elsewhere` },
  { downloadName: "../update.apk" },
  { downloadName: "cohub-v1.6.0-android-arm64-v8a.apk" },
  { downloadSize: 0 },
  { downloadSize: NaN },
  { downloadSize: 1.5 },
  { downloadSha256: null },
  { downloadSha256: "invalid" },
]) assert.throws(() => validateAndroidUpdateAsset({ ...apkRelease, ...invalid }, apkOrigin));
assert.equal(selectYaotaAndroidUpdate({
  apks: [
    { version: "1.6.0", arch: "arm64-v8a", size: 100, sha256: "b".repeat(64), url: androidUpdateApkUrl(apkOrigin, "1.6.0", "arm64-v8a"), status: "Available", createdAt: "2026-01-01T00:00:00.000Z" },
    { version: "1.6.1", arch: "arm64-v8a", size: 123, sha256: "a".repeat(64), url: androidUpdateApkUrl(apkOrigin, "1.6.1", "arm64-v8a"), status: "Available", createdAt: "2026-01-02T00:00:00.000Z" },
    { version: "1.7.0", arch: "x86_64", size: 123, sha256: "c".repeat(64), url: androidUpdateApkUrl(apkOrigin, "1.7.0", "x86_64"), status: "Available", createdAt: "2026-01-03T00:00:00.000Z" },
  ],
}, apkOrigin, "arm64-v8a")?.version, "1.6.1");
const apkAsset = validateAndroidUpdateAsset(apkRelease, apkOrigin);
assert.doesNotThrow(() => verifyAndroidUpdateIntegrity(apkAsset, { size: 123, sha256: "a".repeat(64) }));
assert.throws(() => verifyAndroidUpdateIntegrity(apkAsset, { size: 124, sha256: apkAsset.sha256 }), /verification/);
assert.throws(() => verifyAndroidUpdateIntegrity(apkAsset, { size: 123, sha256: "b".repeat(64) }), /verification/);

const queuedFollowup = (id, sequence, overrides = {}) => ({ id, sequence, status: "queued", intent: "followup", userText: `Follow-up ${id}`, createdAt: "2026-09-01T00:00:00.000Z", ...overrides });
const activeQueueTurn = queuedFollowup("active", 1, { status: "running" });
assert.equal(shouldQueueFollowup([activeQueueTurn], null), true);
assert.equal(shouldQueueFollowup([], { status: "streaming" }), true);
assert.equal(shouldQueueFollowup([], { status: "pending" }), true);
assert.equal(shouldQueueFollowup([queuedFollowup("finished", 1, { status: "completed" })], { status: "completed" }), false);
const photoDraft = { uri: "file:///photo.png", name: "photo.png", mimeType: "image/png", size: 20 };
const fileDraft = { uri: "file:///report.pdf", name: "report.pdf", mimeType: "application/pdf", size: 30 };
for (const busy of [false, true]) {
  for (const [text, attachments] of [["Hello", []], ["", [photoDraft]], ["", [fileDraft]], ["Review these", [photoDraft, fileDraft]]]) {
    const actions = [];
    const uploads = Promise.withResolvers();
    let optimistic;
    const turns = busy ? [activeQueueTurn] : [];
    const sendScope = {
      stateRef: { current: { sessionViews: { fixture: { session: { spaceId: "space" }, turns, messages: [], stream: null } } } },
      client: { space: () => ({ prompt: async () => ({ mode: "immediate", turn: queuedFollowup("accepted", busy ? 2 : 1, { status: busy ? "queued" : "running", meta: { clientMessageId: "client" } }) }) }) },
      translate: (key) => key, newId: () => "client", nextTurnSequence,
      optimisticMessageSequenceRef: { current: new Map() }, userUuid: "user", userKey: "user",
      shouldQueueFollowup, recordDebugEvent: () => {}, dispatch: (action) => actions.push(action), saveMessages: async () => {},
      buildPromptContent: () => uploads.promise, withFallbackUserContent: (turn) => turn, sync: { invalidate: () => {} },
    };
    const send = new Function(...Object.keys(sendScope), ts.transpileModule(`return (${sessionCallbacks.sendMessage});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(sendScope));
    const request = send("fixture", text, attachments, { onOptimistic: (message) => { optimistic = message; } });
    assert.ok(optimistic, "the animation destination exists before uploads complete");
    assert.equal(isOptimisticFollowup(optimistic), busy);
    assert.equal(optimistic.content.filter((block) => block.type === "image").length, attachments.filter((file) => file.mimeType.startsWith("image/")).length);
    if (attachments.includes(fileDraft)) assert.ok(optimistic.content.some((block) => block.type === "text" && block.text.includes("report.pdf")), "files stay visible even with a text caption");
    const localQueue = followupQueueItems(turns, busy ? "active" : null, [optimistic]);
    assert.equal(localQueue.length, busy ? 1 : 0, "queued uploads render as queue items; idle uploads render as messages");
    if (busy) {
      assert.equal(isSendQueueItem(localQueue[0], optimistic), true);
      assert.equal(isSendQueueItem({ ...localQueue[0], clientMessageId: "other" }, optimistic), false);
      assert.equal(localQueue[0].turn, null);
    }
    uploads.resolve(optimistic.content);
    await request;
    const accepted = actions.find((action) => action.type === "turn-upsert").turn;
    const acceptedQueue = followupQueueItems([...turns, accepted], busy ? "active" : accepted.id, [optimistic]);
    assert.equal(acceptedQueue.length, busy ? 1 : 0, "acceptance replaces the optimistic queue item, never duplicates it");
    if (busy) {
      assert.equal(isSendQueueItem(acceptedQueue[0], optimistic), true);
      assert.equal(followupQueueItems([{ ...activeQueueTurn, status: "completed" }, { ...accepted, status: "running" }], accepted.id, [optimistic]).length, 0, "a started turn leaves the queue even if an optimistic snapshot is still present");
    }
  }
}
const reducerFunction = contextSource.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "reducer");
const reduceQueueFailure = new Function("isOptimisticFollowup", "recordDebugEvent", "updateView", ts.transpileModule(`${reducerFunction.getText(contextSource)}; return reducer;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(isOptimisticFollowup, () => {}, (state, id, patch) => ({ ...state, sessionViews: { ...state.sessionViews, [id]: { ...state.sessionViews[id], ...patch } } }));
const failedQueuedMessage = { id: "upload", role: "user", meta: { optimistic: true, queuedFollowup: true, clientMessageId: "failed" } };
const queueFailure = reduceQueueFailure({ sessionViews: { fixture: { messages: [failedQueuedMessage] } } }, { type: "send-failed", sessionId: "fixture", clientMessageId: "failed", message: "Upload failed" });
assert.deepEqual(queueFailure.sessionViews.fixture.messages, [], "failed queued uploads return to the composer, not a failed message bubble");
const cachedSends = [];
const saveQueueMessages = loadChromeComponent("../src/data/local-db.ts", "saveMessages", {
  isOptimisticFollowup,
  database: async () => ({
    withTransactionAsync: async (action) => action(),
    prepareAsync: async () => ({ executeAsync: async (...args) => cachedSends.push(args), finalizeAsync: async () => {} }),
  }),
});
await saveQueueMessages("user", "fixture", [failedQueuedMessage, { id: "accepted", role: "user", meta: { clientMessageId: "accepted" } }]);
assert.deepEqual(cachedSends.map((args) => args[2]), ["accepted"], "unaccepted queue placeholders must not survive a restart as cached messages");
assert.equal(followupPreviewText({ userText: null, userContent: [{ type: "image", _meta: { filename: "photo.png" } }] }), "photo.png");
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
for (const status of ["completed", "failed", "interrupted", "merged", "cancelled"]) {
  const finished = queuedFollowup("finished", 8, { status });
  assert.deepEqual(
    queuedFollowupTurns([finished, queuedFollowup("new", 9)], "finished"),
    [],
    `${status} stream references must not put a new message in the follow-up queue`,
  );
  assert.deepEqual(
    queuedFollowupTurns([finished, queuedFollowup("running", 9, { status: "running" }), queuedFollowup("next", 10)], "finished").map((turn) => turn.id),
    ["next"],
    "a stale stream reference must not hide the queue behind an actually running turn",
  );
}
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

assert.deepEqual(resolveMessageLink("cohub://spaces/241ec263-bd4f-47d6-b459-35b4219e0c23"), { kind: "space", spaceId: "241ec263-bd4f-47d6-b459-35b4219e0c23" });
assert.deepEqual(resolveMessageLink("cohub://spaces/241ec263-bd4f-47d6-b459-35b4219e0c23/sessions/81816f3f-02fa-4b71-b775-ba64a5759c8f"), { kind: "session", spaceId: "241ec263-bd4f-47d6-b459-35b4219e0c23", sessionId: "81816f3f-02fa-4b71-b775-ba64a5759c8f" });
assert.deepEqual(resolveMessageLink("https://cohub.live/spaces/241ec263-bd4f-47d6-b459-35b4219e0c23/sessions/81816f3f-02fa-4b71-b775-ba64a5759c8f?turn=3"), { kind: "session", spaceId: "241ec263-bd4f-47d6-b459-35b4219e0c23", sessionId: "81816f3f-02fa-4b71-b775-ba64a5759c8f" });
assert.deepEqual(resolveMessageLink("/workspace/avatars/out/contact-sheet.png"), { kind: "file", path: "/workspace/avatars/out/contact-sheet.png" });
assert.deepEqual(resolveMessageLink("https://example.com/x"), { kind: "external", url: "https://example.com/x" });
assert.equal(resolveMessageLink("javascript:alert(1)"), null);
assert.equal(resolveMessageLink(""), null);

assert.equal(detectCodeLanguage("src/components/App.tsx"), "tsx");
assert.equal(detectCodeLanguage("docs/readme.md"), "markdown");
assert.equal(detectCodeLanguage("Dockerfile"), "dockerfile");
assert.equal(detectCodeLanguage("Makefile"), null);
assert.equal(resolveCodeLanguage("ts"), "typescript");
assert.equal(resolveCodeLanguage("C++"), "cpp");
assert.equal(resolveCodeLanguage("unknown"), null);

// Streaming code tokenizer: complete lines tokenize once with the carried grammar state, and an
// append only re-tokenizes the trailing partial line.
const streamCalls = [];
const fakeHighlighter = {
  codeToTokens(line, options) {
    streamCalls.push({ line, state: options?.grammarState ?? null });
    return { tokens: [[{ content: line, offset: 0 }]], fg: "#111", bg: "#222", grammarState: `g:${line}` };
  },
};
const streamTokenizer = new StreamingCodeTokenizer(fakeHighlighter, "typescript", "github-dark");
streamTokenizer.enqueue("const a");
streamTokenizer.enqueue(" = 1;\nconst b");
const callsAfterAppend = streamCalls.length;
assert.equal(streamCalls[0].state, null, "the first line starts without grammar state");
assert.equal(streamCalls[2].state, "g:const a = 1;", "complete lines carry the grammar state forward");
streamTokenizer.enqueue(" = 2");
assert.equal(streamCalls.length, callsAfterAppend + 1, "an append only re-tokenizes the trailing line");
assert.deepEqual(streamTokenizer.lines().map((line) => line.map((token) => token.content)), [["const a = 1;"], ["const b = 2"]]);
streamTokenizer.clear();
assert.deepEqual(streamTokenizer.lines(), [], "clear drops buffered token lines");

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

const localDbSource = ts.transpileModule(readFileSync(new URL("../src/data/local-db.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const cacheModule = {};
let databaseOpens = 0;
let schemaRuns = 0;
let failCacheWrite = false;
const preparedWrites = [];
const cacheDatabase = {
  execAsync: async () => { schemaRuns += 1; },
  getFirstAsync: async () => ({ sequence: 4 }),
  withTransactionAsync: async (task) => task(),
  prepareAsync: async (sql) => {
    const write = { sql, rows: [], finalized: false };
    preparedWrites.push(write);
    return {
      executeAsync: async (...params) => {
        if (failCacheWrite) throw new Error("Cache write failed");
        write.rows.push(params);
      },
      finalizeAsync: async () => { write.finalized = true; },
    };
  },
};
new Function("require", "exports", localDbSource)((name) => {
  if (name === "./followup-queue") return { isOptimisticFollowup };
  assert.equal(name, "expo-sqlite");
  return { openDatabaseAsync: async () => { databaseOpens += 1; return cacheDatabase; } };
}, cacheModule);
assert.deepEqual(await Promise.all([
  cacheModule.loadSessionReadSequence("user-a", "chat"),
  cacheModule.loadSessionReadSequence("user-b", "chat"),
]), [4, 4]);
assert.equal(databaseOpens, 1);
assert.equal(schemaRuns, 1, "concurrent cache readers share completed schema initialization");
await cacheModule.saveHome("user-a", {
  spaces: [{ id: "space-a" }, { id: "space-b" }],
  sessions: [{ id: "chat-a", spaceId: "space-a" }, { id: "chat-b", spaceId: "space-b" }],
});
const cacheMessages = [
  { id: "message-a", sequence: 2, meta: { _mobileLive: true, turnId: "turn-a" }, text: "answer" },
  { id: "message-b", sequence: 4, meta: null, text: "next answer" },
];
await cacheModule.saveMessages("user-a", "chat-a", cacheMessages);
assert.equal(preparedWrites.length, 3, "prepare once per table batch, not once per record");
assert.ok(preparedWrites.every((write) => write.rows.length === 2 && write.finalized));
assert.deepEqual(preparedWrites[0].rows.map((row) => row.slice(0, 3)), [
  ["user-a", "space-a", JSON.stringify({ id: "space-a" })],
  ["user-a", "space-b", JSON.stringify({ id: "space-b" })],
]);
assert.deepEqual(preparedWrites[1].rows.map((row) => row.slice(0, 3)), [["user-a", "chat-a", "space-a"], ["user-a", "chat-b", "space-b"]]);
assert.deepEqual(preparedWrites[2].rows.map((row) => row.slice(0, 4)), [["user-a", "chat-a", "message-a", 2], ["user-a", "chat-a", "message-b", 4]]);
assert.deepEqual(JSON.parse(preparedWrites[2].rows[0][4]), { ...cacheMessages[0], meta: { turnId: "turn-a" } });
assert.equal(cacheMessages[0].meta._mobileLive, true, "persistence must not mutate live records");
assert.equal(preparedWrites[2].rows[0][5], preparedWrites[2].rows[1][5], "keep one retention timestamp per batch");
for (const save of [
  () => cacheModule.saveSpaces("user-a", [{ id: "space-a" }]),
  () => cacheModule.saveSessions("user-a", [{ id: "chat-a", spaceId: "space-a" }]),
  () => cacheModule.saveMessages("user-a", "chat-a", cacheMessages),
]) {
  failCacheWrite = true;
  await assert.rejects(save(), /Cache write failed/);
  assert.equal(preparedWrites.at(-1).finalized, true, "failed writes release their prepared statement");
}
assert.equal(schemaRuns, 1, "writes do not repeat schema setup");

// LegendList memoizes each row on [item, extraData], unlike FlatList cells that re-rendered
// with renderItem identity. Rows that read state outside `data` must forward it through
// extraData, or in-place updates (thinking options, async counts, turn selection, fork/send
// feedback) never reach mounted rows.
for (const path of [
  "../src/components/ModelSelectorMenu.tsx",
  "../src/components/TurnNavigatorSheet.tsx",
  "../src/components/SpacePanels.tsx",
  "../app/(tabs)/index.tsx",
  "../app/(tabs)/spaces.tsx",
  "../app/chat/[sessionId].tsx",
  "../app/space/[spaceId]/files.tsx",
]) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  assert.ok(/<LegendList[\s\S]*?extraData=/.test(source), `${path} must pass extraData so LegendList rows re-render on external state`);
}

console.log("Chat workflow checks passed");
