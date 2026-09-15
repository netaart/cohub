import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Modal, Pressable, Share, Text, TextInput, View, useWindowDimensions, type LayoutChangeEvent, type ViewToken } from "react-native";
import { Easing, interpolate, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { AnchoredActionMenu } from "@/src/components/AnchoredActionMenu";
import { useToast } from "@/src/components/Toast";
import { copyMessageText, MessageBubble, StreamCard } from "@/src/components/MessageContent";
import { StreamingTurnProcess, TurnProcess } from "@/src/components/TurnProcess";
import { ModelSelectorMenu } from "@/src/components/ModelSelectorMenu";
import { AttachmentMenu } from "@/src/components/AttachmentMenu";
import { SessionLabelSheet } from "@/src/components/SessionLabelSheet";
import { fetchSessionLabels, toUserSessionLabels, type SessionLabel } from "@/src/data/session-labels";
import { TurnNavigatorSheet } from "@/src/components/TurnNavigatorSheet";
import { SpacePanels, type SpacePanel } from "@/src/components/SpacePanels";
import { useApp, useSession } from "@/src/data/context";
import { CHAT_PAGE_THRESHOLD, chatListDistances, chatListViewOffset, nextChatTailFollowing } from "@/src/data/chat-scroll";
import { chatScrollTrace, type TraceFields } from "@/src/data/chat-scroll-trace";
import { record as recordDebugEvent } from "@/src/data/debug-session";
import { useChatScrollTrace, useTraceTouches } from "@/src/components/use-chat-scroll-trace";
import { useChatVisibleRows } from "@/src/components/use-chat-visible-rows";
import { markChatEntry } from "@/src/data/chat-entry-trace";
import { cancelQueuedFollowup, followupPreviewText, queuedFollowupTurns, steerQueuedFollowup } from "@/src/data/followup-queue";
import { isActiveTurnStatus, isLiveStreamStatus, isTerminalTurnStatus, shouldShowLiveStream } from "@/src/data/chat-stream";
import { MessageMeasurements } from "@/src/data/chat-rendering";
import type { AttachmentDraft, ChatModelSelection } from "@/src/data/types";
import type { CohubClient, MessageRecord, SessionTurnRecord } from "@neta-art/cohub";
import { chatThreadPlaceholder, mergeDisplayMessages, messageIndexForTurn, messagesFromTurns, turnSequenceForMessage, withTurnSequences } from "@/src/data/session-history";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { formatThinkingLevel, modelAvailabilityLevel, requestedThinkingLevel } from "@/src/model-catalog";
import { useNativeVoiceInput } from "@/src/platform/native-voice-input";
import { AppIcon, AttachmentChip, ComposerInput, ConnectionBanner, TopBar, IconButton, PrimaryButton, Screen } from "@/src/ui";
import { displaySessionTitle, displaySpaceName, hasRenderableMessage, isAssistantIntermediate, messageText } from "@/src/utils";
import { EdgeFooter, EdgeHeader, useEdgeChrome } from "@/src/ui/EdgeChrome";

type RouteParams = { sessionId?: string | string[]; spaceId?: string | string[]; turn?: string | string[]; turnId?: string | string[] };
const messageViewabilityConfig = { itemVisiblePercentThreshold: 20 };
/** Only used to estimate the destination of a jump the list cannot resolve on its own. */
const FALLBACK_ROW_HEIGHT = 140;

function sendTransitionKey(message: Pick<MessageRecord, "id" | "meta">) {
  const clientMessageId = message.meta?.clientMessageId;
  return typeof clientMessageId === "string" ? `client:${clientMessageId}` : `message:${message.id}`;
}

type SendTransition = { text: string; startedAt: string; sourceX: number; sourceY: number; targetX: number; targetY: number; targetHeight: number };

// Row height depends on rendered text/blocks, not on the metadata JSON stringify would also
// walk. A transcript-wide JSON.stringify on every turn patch dominated list re-renders.
function measurementRevision(message: MessageRecord, previousTurnSequence: number | null) {
  let blockSignature = "";
  for (const block of message.content ?? []) {
    if (block.type === "text") blockSignature += `t${block.text.length};`;
    else if (block.type === "thinking") blockSignature += `k${block.thinking.length};`;
    else blockSignature += `${block.type};`;
  }
  const usage = message.usage;
  return [
    message.id,
    turnSequenceForMessage(message) ?? -1,
    previousTurnSequence ?? -1,
    message.role,
    message.text?.length ?? 0,
    message.errorMessage?.length ?? 0,
    blockSignature,
    message.model ?? "",
    usage?.input ?? 0,
    usage?.cacheRead ?? 0,
    usage?.output ?? 0,
  ].join(":");
}

type ChatScrollEvent = {
  nativeEvent: {
    contentOffset: { y: number };
    contentSize: { height: number };
    layoutMeasurement: { height: number };
    velocity?: { y?: number };
  };
};

export default function ChatScreen() {
  const params = useLocalSearchParams<RouteParams>();
  const sessionId = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId;
  const spaceId = Array.isArray(params.spaceId) ? params.spaceId[0] : params.spaceId;
  const rawTurn = Array.isArray(params.turn) ? params.turn[0] : params.turn;
  const rawTurnId = Array.isArray(params.turnId) ? params.turnId[0] : params.turnId;
  const parsedTurn = rawTurn ? Number(rawTurn) : NaN;
  const initialTurnSequence = Number.isSafeInteger(parsedTurn) && parsedTurn > 0 ? parsedTurn : null;
  const initialTurnId = rawTurnId?.trim() || null;
  if (!sessionId) return <MissingChat />;
  if (sessionId === "new") return spaceId ? <DraftChatContent spaceId={spaceId} /> : <MissingChat />;
  return <ChatContent key={sessionId} sessionId={sessionId} initialTurnSequence={initialTurnSequence} initialTurnId={initialTurnId} />;
}

function ChatContent({ sessionId, initialTurnSequence, initialTurnId }: { sessionId: string; initialTurnSequence: number | null; initialTurnId: string | null }) {
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const showToast = useToast();
  const { state, client, connectionState, refreshHome, sendMessage, abortSession, refreshSession, loadOlderTurns, loadNewerTurns, loadTurnIndex, jumpToTurn, renameSession, forkSession, getAccessToken, loadModels, loadModelStatus, models, modelsLoading, modelsError, modelStatus, modelStatusLoading, modelStatusError, loadSessionReadSequence, saveSessionReadSequence } = useApp();
  const view = useSession(sessionId);
  const { headerHeight, footerHeight, onHeaderLayout, onFooterLayout } = useEdgeChrome();
  const composerRef = useRef<View>(null);
  const [sendTransition, setSendTransition] = useState<SendTransition | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [input, setInput] = useState("");
  const [sendFeedback, setSendFeedback] = useState<"idle" | "success">("idle");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<View>(null);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const [labelSheetOpen, setLabelSheetOpen] = useState(false);
  const [chatLabels, setChatLabels] = useState<SessionLabel[]>([]);
  const [renameValue, setRenameValue] = useState("");
  const [stopping, setStopping] = useState(false);
  const [pendingFollowupAction, setPendingFollowupAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ChatModelSelection | null>(null);
  const [modelOverride, setModelOverride] = useState(false);
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(null);
  const [forkingTurnId, setForkingTurnId] = useState<string | null>(null);
  const [turnNavigatorOpen, setTurnNavigatorOpen] = useState(false);
  const [loadingSequence, setLoadingSequence] = useState<number | null>(null);
  // A running Chat carries its live turn snapshot in memory, so its first paint has to render
  // it. Mount the committed history first and attach the live card on the next task so a long
  // running turn cannot block the screen transition.
  const [liveStreamReady, setLiveStreamReady] = useState(false);
  // Entry timeline for the opt-in diagnostics: markChatEntry is a no-op unless enabled.
  const entryRendersRef = useRef(0);
  const entryHistoryLoadedRef = useRef(false);
  const entryStatsRef = useRef({ messages: 0, turns: 0, hasStream: false, historyLoaded: false });
  const [currentTurnSequence, setCurrentTurnSequence] = useState<number | null>(null);
  const pendingScrollSequence = useRef<number | null>(null);
  const handledDeepLinkTarget = useRef<string | null>(null);
  const listRef = useRef<LegendListRef>(null);
  const listContainerRef = useRef<View>(null);
  const sendBubbleRef = useRef<View>(null);
  const [transitionMessageKey, setTransitionMessageKey] = useState<string | null>(null);
  const initialScrollDone = useRef(false);
  const initialUnreadIndexRef = useRef<number | null>(null);
  const initialUnreadRetriesRef = useRef(0);
  const readStateLoadedRef = useRef(false);
  const readSequenceRef = useRef<number | null>(null);
  const savedReadSequenceRef = useRef<number | null>(null);
  const followingTailRef = useRef(true);
  const [followingTail, setFollowingTailState] = useState(true);
  const userDraggingRef = useRef(false);
  const momentumScrollingRef = useRef(false);
  const followTailFrameRef = useRef<number | null>(null);
  const turnScrollTargetRef = useRef<number | null>(null);
  const turnScrollRetriesRef = useRef(new Map<number, number>());
  const turnScrollRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollRef = useRef({ y: 0, height: 0, viewport: 0 });
  const traceRequestId = useRef(0);
  const traceCancelGeneration = useRef(0);
  const traceState = useCallback((): TraceFields => ({
    session: chatScrollTrace.alias("session", sessionId),
    pendingSequence: pendingScrollSequence.current, targetSequence: turnScrollTargetRef.current,
    retryTimerPending: turnScrollRetryTimerRef.current !== null,
    retries: turnScrollTargetRef.current === null ? null : turnScrollRetriesRef.current.get(turnScrollTargetRef.current) ?? 0,
    following: followingTailRef.current, dragging: userDraggingRef.current, momentum: momentumScrollingRef.current,
    initialDone: initialScrollDone.current, followFramePending: followTailFrameRef.current !== null,
    cancelGeneration: traceCancelGeneration.current,
    inverted: false,
    ...lastScrollRef.current,
  }), [sessionId]);
  const { recording: tracing, log: trace } = useChatScrollTrace("chat", traceState);
  const traceTouches = useTraceTouches("chat.list", traceState, tracing);
  const traceOffset = useCallback((source: string, options: { offset: number; animated: boolean }) => {
    trace("command.scrollToOffset", { source, ...options, hasList: Boolean(listRef.current) });
    listRef.current?.scrollToOffset(options);
  }, [trace]);
  const traceEnd = useCallback((source: string, animated: boolean) => {
    trace("command.scrollToEnd", { source, animated, hasList: Boolean(listRef.current) });
    listRef.current?.scrollToEnd({ animated });
  }, [trace]);
  const traceIndex = useCallback((source: string, options: { index: number; animated: boolean; viewPosition: number; viewOffset: number }) => {
    trace("command.scrollToIndex", { source, ...options, hasList: Boolean(listRef.current) });
    // Chronological list: only the overlaid top bar has to be compensated.
    const viewOffset = chatListViewOffset(options.viewPosition, options.viewOffset, headerHeight);
    return listRef.current?.scrollToIndex({ ...options, viewOffset }) ?? Promise.resolve();
  }, [headerHeight, trace]);
  const setFollowingTail = useCallback((next: boolean) => {
    if (followingTailRef.current === next) return;
    trace("tail.followingChanged", { next });
    followingTailRef.current = next;
    setFollowingTailState(next);
  }, [trace]);
  const cancelTurnScroll = useCallback(() => {
    traceCancelGeneration.current += 1;
    trace("turn.cancel");
    pendingScrollSequence.current = null;
    turnScrollTargetRef.current = null;
    turnScrollRetriesRef.current.clear();
    if (turnScrollRetryTimerRef.current !== null) {
      clearTimeout(turnScrollRetryTimerRef.current);
      turnScrollRetryTimerRef.current = null;
    }
  }, [trace]);
  const requestFollowTail = useCallback((animated = false) => {
    trace("tail.request", { animated });
    if (!followingTailRef.current || userDraggingRef.current || momentumScrollingRef.current || pendingScrollSequence.current !== null || turnScrollTargetRef.current !== null) return;
    if (followTailFrameRef.current !== null) cancelAnimationFrame(followTailFrameRef.current);
    followTailFrameRef.current = requestAnimationFrame(() => {
      followTailFrameRef.current = null;
      if (!followingTailRef.current || userDraggingRef.current || momentumScrollingRef.current || pendingScrollSequence.current !== null || turnScrollTargetRef.current !== null) return;
      traceEnd("tail.frame", animated);
      requestAnimationFrame(() => {
        if (!followingTailRef.current || userDraggingRef.current || momentumScrollingRef.current) return;
        traceEnd("tail.secondFrame", false);
      });
    });
  }, [trace, traceEnd]);
  const onVisibleRows = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    if (chatScrollTrace.isRecording()) trace("list.viewable", { items: viewableItems.map((item) => ({ index: item.index, visible: item.isViewable, message: chatScrollTrace.alias("message", (item.item as MessageRecord).id), turn: turnSequenceForMessage(item.item as MessageRecord) })) });
    const ordered = viewableItems
      .filter((item) => item.isViewable && item.item && typeof item.item === "object")
      .sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
    if (initialUnreadIndexRef.current !== null) {
      const initialUnreadVisible = ordered.some((item) => item.index === initialUnreadIndexRef.current);
      if (initialUnreadVisible) {
        initialUnreadIndexRef.current = null;
        initialUnreadRetriesRef.current = 0;
      } else {
        return;
      }
    }
    if (readStateLoadedRef.current && initialScrollDone.current) {
      const visibleAssistantSequence = ordered.reduce((latest, item) => {
        const message = item.item as MessageRecord;
        if (message.role !== "assistant") return latest;
        const sequence = turnSequenceForMessage(message);
        return sequence !== null ? Math.max(latest, sequence) : latest;
      }, readSequenceRef.current ?? 0);
      if (visibleAssistantSequence > (readSequenceRef.current ?? 0)) {
        readSequenceRef.current = visibleAssistantSequence;
        if (visibleAssistantSequence > (savedReadSequenceRef.current ?? 0)) {
          savedReadSequenceRef.current = visibleAssistantSequence;
          void saveSessionReadSequence(sessionId, visibleAssistantSequence).catch(() => undefined);
        }
      }
    }
    const target = turnScrollTargetRef.current;
    if (target !== null) {
      if (ordered.some((item) => turnSequenceForMessage((item.item as { meta: Record<string, unknown> | null })) === target)) {
        trace("turn.targetVisible", { sequence: target });
        turnScrollTargetRef.current = null;
        turnScrollRetriesRef.current.delete(target);
        if (turnScrollRetryTimerRef.current !== null) {
          clearTimeout(turnScrollRetryTimerRef.current);
          turnScrollRetryTimerRef.current = null;
        }
        setCurrentTurnSequence(target);
      }
      return;
    }
    // Chronological list: the first viewable row is the one at the top of the viewport.
    const visualTop = ordered[0];
    if (visualTop?.item) setCurrentTurnSequence(turnSequenceForMessage(visualTop.item as { meta: Record<string, unknown> | null }));
  }, [saveSessionReadSequence, sessionId, trace]);
  const { onViewableItemsChanged, measureVisibleRows, trackRow } = useChatVisibleRows({ viewportRef: listContainerRef, topInset: headerHeight, bottomInset: footerHeight, onVisible: onVisibleRows });
  const session = view.session ?? state.sessions.find((item) => item.id === sessionId) ?? null;
  const sessionSummary = state.sessions.find((item) => item.id === sessionId) ?? null;
  const spaceId = view.space?.id ?? session?.spaceId ?? sessionSummary?.spaceId ?? "";
  const spaceName = view.space ? displaySpaceName(view.space) : sessionSummary?.space?.name || t("space.fallbackName");
  const spaceSessions = useMemo(() => state.sessions.filter((item) => item.spaceId === spaceId), [spaceId, state.sessions]);
  const queuedFollowups = useMemo(() => queuedFollowupTurns(view.turns, view.stream?.turnId), [view.stream?.turnId, view.turns]);
  const queuedFollowupIds = useMemo(() => new Set(queuedFollowups.map((turn) => turn.id)), [queuedFollowups]);
  useEffect(() => { recordDebugEvent("chat.queue.state", { count: queuedFollowups.length, ids: queuedFollowups.map((turn) => chatScrollTrace.alias("turn", turn.id)) }); }, [queuedFollowups]);
  const messages = useMemo(() => {
    const history = messagesFromTurns(view.turns);
    return withTurnSequences(
      mergeDisplayMessages(history.length > 0 ? history : view.messages, history.length > 0 ? view.messages : [])
        .filter((message) => !isAssistantIntermediate(message) && hasRenderableMessage(message) && !(typeof message.meta?.turnId === "string" && queuedFollowupIds.has(message.meta.turnId))),
      view.turns,
    );
  }, [queuedFollowupIds, view.messages, view.turns]);
  const timeline = useMemo(() => messages.slice().reverse(), [messages]);
  // renderItem previously ran linear `find`/`filter` over every turn for every rendered row.
  const turnIndexBySequence = useMemo(() => new Map(view.turnIndex.map((entry) => [entry.sequence, entry])), [view.turnIndex]);
  const turnsById = useMemo(() => new Map(view.turns.map((entry) => [entry.id, entry])), [view.turns]);
  const turnsBySequence = useMemo(() => {
    const map = new Map<number, SessionTurnRecord[]>();
    for (const entry of view.turns) {
      const list = map.get(entry.sequence);
      if (list) list.push(entry);
      else map.set(entry.sequence, [entry]);
    }
    return map;
  }, [view.turns]);
  const transitionMessage = transitionMessageKey !== null
    ? timeline.find((item) => item.role === "user" && sendTransitionKey(item) === transitionMessageKey) ?? null
    : sendTransition
      ? timeline.find((item) => item.role === "user" && sendTransition.text === messageText(item) && item.createdAt >= sendTransition.startedAt) ?? null
      : null;

  useEffect(() => {
    if (!tracing) return;
    trace("chat.state", {
      messageCount: messages.length, turnCount: view.turns.length,
      loading: view.loading, historyLoaded: view.historyLoaded, refreshing: view.refreshing,
      loadingOlder: view.loadingOlder, loadingNewer: view.loadingNewer,
      hasMoreOlder: view.hasMoreOlder, hasMoreNewer: view.hasMoreNewer,
      streamStatus: view.stream?.status ?? null, sending: view.sending,
      activePanel, currentTurnSequence, turnNavigatorOpen,
      initialTurnSequence, hasInitialTurnId: initialTurnId !== null,
      inverted: false, maintainVisibleContentPosition: !followingTail,
    });
  }, [activePanel, currentTurnSequence, followingTail, initialTurnId, initialTurnSequence, messages.length, trace, tracing, turnNavigatorOpen, view.hasMoreNewer, view.hasMoreOlder, view.historyLoaded, view.loading, view.loadingNewer, view.loadingOlder, view.refreshing, view.sending, view.stream?.status, view.turns.length]);
  const { fontScale } = useWindowDimensions();
  // App text size changes row heights, so it participates in the measurement cache key.
  const textSizeToken = typography.chatBody.fontSize;
  const [listWidth, setListWidth] = useState(0);
  const measurements = useMemo(() => {
    const cache = new MessageMeasurements();
    cache.configure(`${listWidth}:${fontScale}:${theme.mode}:${textSizeToken}`, []);
    return cache;
  }, [listWidth, fontScale, textSizeToken, theme.mode]);
  const measuredMessages = useMemo(() => messages.map((message, index) => ({
    id: message.id,
    revision: measurementRevision(message, index > 0 ? turnSequenceForMessage(messages[index - 1]!) : null),
  })), [messages]);
  useEffect(() => {
    measurements.configure(`${listWidth}:${fontScale}:${theme.mode}:${textSizeToken}`, measuredMessages);
  }, [measurements, measuredMessages, listWidth, fontScale, textSizeToken, theme.mode]);
  const estimatedOffset = useCallback((index: number, averageHeight: number) => {
    const fromOldest = index < 0 ? 0 : measurements.estimateOffset(measuredMessages, index, averageHeight);
    return headerHeight + 12 + (view.hasMoreOlder ? 50 : 0) + fromOldest;
  }, [headerHeight, measurements, measuredMessages, view.hasMoreOlder]);
  let recordedModel: ChatModelSelection | null = null;
  let hasRelevantTurn = false;
  for (const turn of [...view.turns].reverse()) {
    if (turn.executionKind === "direct_generation" || turn.provider === "generation") continue;
    hasRelevantTurn = true;
    if (turn.model) {
      const provider = turn.provider || "cohub";
      const catalogItem = models.find((item) => item.provider === provider && item.id === turn.model);
      const name = catalogItem?.model?.name;
      const requestedLevel = requestedThinkingLevel(turn.meta);
      recordedModel = { provider, id: turn.model, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}), ...(requestedLevel ? { thinkingLevel: requestedLevel } : {}) };
    }
    break;
  }
  if (!hasRelevantTurn && !recordedModel) {
    for (const message of [...messages].reverse()) {
      if (message.meta?.messageKind === "generation_result" || message.provider === "generation") continue;
      if (!message.model && message.role !== "assistant") continue;
      if (message.model) {
        const provider = message.provider || "cohub";
        const catalogItem = models.find((item) => item.provider === provider && item.id === message.model);
        const name = catalogItem?.model?.name;
        const requestedLevel = requestedThinkingLevel(message.meta);
        recordedModel = { provider, id: message.model, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}), ...(requestedLevel ? { thinkingLevel: requestedLevel } : {}) };
      }
      break;
    }
  }
  const activeModel = modelOverride ? selectedModel : recordedModel;
  const activeStatus = activeModel ? modelAvailabilityLevel(modelStatus?.models[activeModel.id]) : "unknown";
  const modelLabel = activeModel?.name || activeModel?.id || t("chat.model.automatic");
  const modelTriggerLabel = activeModel?.thinkingLevel ? `${modelLabel} · ${formatThinkingLevel(activeModel.thinkingLevel)}` : modelLabel;
  const liveStream = shouldShowLiveStream(view.stream, messages);
  const threadPlaceholder = chatThreadPlaceholder({
    messageCount: timeline.length,
    historyLoaded: view.historyLoaded,
    error: view.error,
    hasLiveActivity: Boolean(liveStream || view.sending),
  });
  const running = state.sessionLatestTurns[sessionId]?.status === "running" || view.sending || (liveStream && isLiveStreamStatus(view.stream?.status ?? ""));
  const voice = useNativeVoiceInput({ getAccessToken, onFinal: (text) => setInput((current) => current.trim() ? `${current.trim()} ${text}` : text) });

  useEffect(() => {
    const timer = setTimeout(() => setLiveStreamReady(true), 0);
    return () => clearTimeout(timer);
  }, [sessionId]);

  useEffect(() => {
    entryRendersRef.current += 1;
    entryStatsRef.current = { messages: view.messages.length, turns: view.turns.length, hasStream: Boolean(view.stream), historyLoaded: view.historyLoaded };
  });

  useEffect(() => {
    markChatEntry("screen.mount", entryStatsRef.current);
    const timer = setTimeout(() => markChatEntry("settled", { ...entryStatsRef.current, renders: entryRendersRef.current }), 1000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (entryHistoryLoadedRef.current || !view.historyLoaded) return;
    entryHistoryLoadedRef.current = true;
    markChatEntry("history.loaded", { turns: view.turns.length, renders: entryRendersRef.current });
  }, [view.historyLoaded, view.turns.length]);

  useEffect(() => {
    if (liveStreamReady) markChatEntry("live.attached", { renders: entryRendersRef.current });
  }, [liveStreamReady]);

  useEffect(() => {
    let active = true;
    readStateLoadedRef.current = false;
    readSequenceRef.current = null;
    savedReadSequenceRef.current = null;
    void loadSessionReadSequence(sessionId).then((sequence) => {
      if (!active) return;
      readSequenceRef.current = sequence;
      savedReadSequenceRef.current = sequence;
      readStateLoadedRef.current = true;
    }).catch(() => {
      if (active) readStateLoadedRef.current = true;
    });
    return () => { active = false; };
  }, [loadSessionReadSequence, sessionId]);

  const hasInitialTurnTarget = initialTurnId !== null || initialTurnSequence !== null;
  const targetMessageIndex = useCallback((sequence: number) => {
    const exactIndex = messageIndexForTurn(messages, sequence);
    if (exactIndex >= 0) return exactIndex;
    return messages.findIndex((message) => {
      const messageSequence = turnSequenceForMessage(message);
      return messageSequence !== null && messageSequence > sequence;
    });
  }, [messages]);
  const targetIsLatestMessage = useCallback(() => {
    const target = turnScrollTargetRef.current;
    const lastMessage = messages.at(-1);
    return target !== null && lastMessage !== undefined && turnSequenceForMessage(lastMessage) === target;
  }, [messages]);
  const requestInitialScroll = useCallback(() => {
    if (!view.historyLoaded || initialScrollDone.current || messages.length === 0 || hasInitialTurnTarget) return;
    initialScrollDone.current = true;
    traceEnd("initial.latest", false);
    setFollowingTail(true);
    setCurrentTurnSequence(view.turns.at(-1)?.sequence ?? null);
  }, [hasInitialTurnTarget, messages.length, setFollowingTail, traceEnd, view.historyLoaded, view.turns]);

  // Legend resolves `scrollToIndex` for unrendered rows from its own estimates; when it rejects the
  // row is too far away, so park at an estimated offset and let the retry timer re-target it.
  const scrollToMessageIndex = useCallback((source: string, index: number, animated: boolean) => {
    void traceIndex(source, { index, animated, viewPosition: 0.15, viewOffset: 8 }).catch(() => {
      trace("command.scrollToIndexEstimate", { source, index });
      traceOffset(`${source}.estimate`, { offset: estimatedOffset(index, FALLBACK_ROW_HEIGHT), animated: false });
    });
  }, [estimatedOffset, trace, traceIndex, traceOffset]);

  const scheduleTurnScrollRetry = useCallback((sequence: number, retry: number) => {
    trace("turn.retrySchedule", { sequence, retry, exhausted: retry >= 4 });
    if (retry >= 4) {
      if (turnScrollTargetRef.current === sequence) turnScrollTargetRef.current = null;
      turnScrollRetriesRef.current.delete(sequence);
      return;
    }
    if (turnScrollRetryTimerRef.current !== null) clearTimeout(turnScrollRetryTimerRef.current);
    turnScrollRetryTimerRef.current = setTimeout(() => {
      turnScrollRetryTimerRef.current = null;
      trace("turn.retryFire", { sequence, retry });
      if (turnScrollTargetRef.current !== sequence) return;
      const index = targetMessageIndex(sequence);
      if (index < 0 || !listRef.current) return;
      turnScrollRetriesRef.current.set(sequence, retry + 1);
      scrollToMessageIndex("turn.retryTimer", index, false);
    }, retry === 0 ? 120 : 180);
  }, [scrollToMessageIndex, targetMessageIndex, trace]);
  const scrollToTurn = useCallback((sequence: number, retry = 0) => {
    const index = targetMessageIndex(sequence);
    trace("turn.scrollRequest", { sequence, retry, index, messageCount: messages.length });
    turnScrollTargetRef.current = sequence;
    turnScrollRetriesRef.current.set(sequence, retry);
    setFollowingTail(false);
    if (index < 0) {
      pendingScrollSequence.current = sequence;
      return;
    }
    if (!listRef.current) {
      pendingScrollSequence.current = sequence;
      return;
    }
    pendingScrollSequence.current = null;
    initialScrollDone.current = true;
    scrollToMessageIndex("turn.scrollToTurn", index, retry === 0);
    scheduleTurnScrollRetry(sequence, retry);
    setCurrentTurnSequence(sequence);
  }, [messages.length, scheduleTurnScrollRetry, scrollToMessageIndex, setFollowingTail, targetMessageIndex, trace]);

  const handleTurnJump = async (sequence: number) => {
    const requestId = ++traceRequestId.current;
    const cancelGeneration = traceCancelGeneration.current;
    setLoadingSequence(sequence);
    try {
      trace("turn.jumpStart", { sequence, origin: "navigator", requestId });
      const resolvedSequence = await jumpToTurn(sessionId, sequence);
      trace("turn.jumpResolved", { sequence, resolvedSequence, origin: "navigator", requestId, cancelledWhileWaiting: cancelGeneration !== traceCancelGeneration.current });
      scrollToTurn(resolvedSequence);
      setTurnNavigatorOpen(false);
    } catch (error) {
      trace("turn.jumpFailed", { origin: "navigator", requestId });
      setNotice({ title: t("chat.turnUnavailable.title"), message: error instanceof Error ? error.message : t("chat.turnUnavailable.body") });
    } finally {
      setLoadingSequence(null);
    }
  };

  useEffect(() => {
    initialScrollDone.current = false;
    initialUnreadIndexRef.current = null;
    initialUnreadRetriesRef.current = 0;
    pendingScrollSequence.current = null;
    userDraggingRef.current = false;
    momentumScrollingRef.current = false;
    turnScrollTargetRef.current = null;
    turnScrollRetriesRef.current.clear();
    if (turnScrollRetryTimerRef.current !== null) {
      clearTimeout(turnScrollRetryTimerRef.current);
      turnScrollRetryTimerRef.current = null;
    }
    handledDeepLinkTarget.current = null;
  }, [sessionId]);

  useEffect(() => {
    const frame = requestAnimationFrame(requestInitialScroll);
    return () => cancelAnimationFrame(frame);
  }, [requestInitialScroll]);

  useEffect(() => () => {
    if (followTailFrameRef.current !== null) cancelAnimationFrame(followTailFrameRef.current);
    if (turnScrollRetryTimerRef.current !== null) clearTimeout(turnScrollRetryTimerRef.current);
  }, []);

  useEffect(() => {
    const targetKey = initialTurnId ? `id:${initialTurnId}` : initialTurnSequence !== null ? `sequence:${initialTurnSequence}` : null;
    if (!targetKey || !client || !spaceId || !view.historyLoaded || handledDeepLinkTarget.current === targetKey) return;
    handledDeepLinkTarget.current = targetKey;
    const target = initialTurnId ? { turnId: initialTurnId } : initialTurnSequence;
    if (target === null) return;
    const requestId = ++traceRequestId.current;
    const cancelGeneration = traceCancelGeneration.current;
    void (async () => {
      try {
        if (chatScrollTrace.isRecording()) trace("turn.jumpStart", { origin: "deepLink", requestId, target: typeof target === "number" ? target : chatScrollTrace.alias("turn", target.turnId) });
        const sequence = await jumpToTurn(sessionId, target);
        trace("turn.jumpResolved", { origin: "deepLink", sequence, requestId, cancelledWhileWaiting: cancelGeneration !== traceCancelGeneration.current });
        pendingScrollSequence.current = sequence;
        scrollToTurn(sequence);
      } catch (error) {
        trace("turn.jumpFailed", { origin: "deepLink", requestId });
        setNotice({ title: t("chat.turnUnavailable.title"), message: error instanceof Error ? error.message : t("chat.turnUnavailable.deepLinkBody") });
      }
    })();
  }, [client, initialTurnId, initialTurnSequence, jumpToTurn, scrollToTurn, sessionId, spaceId, t, trace, view.historyLoaded, view.turns]);

  useEffect(() => {
    if (turnNavigatorOpen) void loadTurnIndex(sessionId, { force: true }).catch(() => undefined);
  }, [loadTurnIndex, sessionId, turnNavigatorOpen]);

  const appendAttachments = (next: AttachmentDraft[]) => setAttachments((current) => [...current, ...next].slice(0, 6));
  const pickAttachments = async () => {
    setAttachmentMenuOpen(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      appendAttachments(result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType || "application/octet-stream", size: asset.size ?? 0 })));
    } catch (error) { showToast({ title: t("chat.attachmentUnavailable.title"), message: error instanceof Error ? error.message : t("chat.attachmentUnavailable.body"), tone: "danger" }); }
  };
  const pickPhotos = async () => {
    setAttachmentMenuOpen(false);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) { showToast({ title: t("chat.photoOff.title"), message: t("chat.photoOff.body"), tone: "danger" }); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 0.88 });
      if (result.canceled) return;
      appendAttachments(result.assets.map((asset, index) => ({ uri: asset.uri, name: asset.fileName || `image-${index + 1}.jpg`, mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 })));
    } catch (error) { showToast({ title: t("chat.photoPickerUnavailable.title"), message: error instanceof Error ? error.message : t("chat.photoPickerUnavailable.body"), tone: "danger" }); }
  };
  const takePhoto = async () => {
    setAttachmentMenuOpen(false);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) { showToast({ title: t("chat.cameraOff.title"), message: t("chat.cameraOff.body"), tone: "danger" }); return; }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.88 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset) appendAttachments([{ uri: asset.uri, name: asset.fileName || "camera-photo.jpg", mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 }]);
    } catch (error) { showToast({ title: t("chat.cameraUnavailable.title"), message: error instanceof Error ? error.message : t("chat.cameraUnavailable.body"), tone: "danger" }); }
  };
  const stopGeneration = async () => {
    if (stopping) return;
    setStopping(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try { await abortSession(sessionId); } catch (error) { showToast({ title: t("chat.stopFailed.title"), message: error instanceof Error ? error.message : t("chat.stopFailed.body"), tone: "danger" }); } finally { setStopping(false); }
  };
  const runFollowupAction = async (turnId: string, action: "steer" | "cancel") => {
    if (!client || !spaceId || pendingFollowupAction !== null) return;
    setPendingFollowupAction(turnId);
    if (action === "steer") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      if (action === "steer") await steerQueuedFollowup(client, spaceId, sessionId, turnId);
      else await cancelQueuedFollowup(client, spaceId, sessionId, turnId);
      await refreshSession(sessionId);
    } catch (error) {
      showToast({ title: action === "steer" ? t("chat.steerFailed.title") : t("chat.cancelFailed.title"), message: error instanceof Error ? error.message : t("chat.followupFailed.body"), tone: "danger" });
      void refreshSession(sessionId).catch(() => undefined);
    } finally {
      setPendingFollowupAction(null);
    }
  };
  const shareChat = async () => {
    const title = session ? displaySessionTitle(session) : t("chat.title");
    if (!spaceId) {
      showToast({ title: t("chat.shareFailed.title"), message: t("chat.shareFailed.body"), tone: "danger" });
      return;
    }
    const url = `https://cohub.live/spaces/${encodeURIComponent(spaceId)}/sessions/${encodeURIComponent(sessionId)}`;
    await Share.share({ message: `${title}\n${url}`, url, title });
  };
  const openRename = () => { setRenameValue(session ? displaySessionTitle(session) : ""); setRenameOpen(true); };
  const openLabelSheet = () => {
    setLabelSheetOpen(true);
    if (!client || !spaceId) return;
    void fetchSessionLabels(client, spaceId)
      .then((tree) => setChatLabels(toUserSessionLabels(tree)))
      .catch(() => setChatLabels([]));
  };
  const saveRename = async () => {
    try { await renameSession(sessionId, renameValue); setRenameOpen(false); } catch (error) { showToast({ title: t("chat.renameFailed.title"), message: error instanceof Error ? error.message : t("chat.renameFailed.body"), tone: "danger" }); }
  };
  const handleScroll = useCallback((event: ChatScrollEvent) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    trace("list.scroll", { previousY: lastScrollRef.current.y, deltaY: contentOffset.y - lastScrollRef.current.y, offsetY: contentOffset.y, contentHeight: contentSize.height, viewportHeight: layoutMeasurement.height });
    lastScrollRef.current = { y: contentOffset.y, height: contentSize.height, viewport: layoutMeasurement.height };
    measureVisibleRows();
    const { distanceToLatest, distanceToOldest } = chatListDistances(contentOffset.y, contentSize.height, layoutMeasurement.height);
    setFollowingTail(nextChatTailFollowing({
      currentlyFollowing: followingTailRef.current,
      distanceToBottom: distanceToLatest,
      userInteracting: userDraggingRef.current || momentumScrollingRef.current,
      pendingTarget: pendingScrollSequence.current !== null || (turnScrollTargetRef.current !== null && !targetIsLatestMessage()),
    }));
    if (initialScrollDone.current && distanceToOldest < CHAT_PAGE_THRESHOLD && view.hasMoreOlder && !view.loadingOlder) {
      trace("pagination.request", { direction: "older", distanceToOldest });
      void loadOlderTurns(sessionId);
    }
    if (distanceToLatest < CHAT_PAGE_THRESHOLD && view.hasMoreNewer && !view.loadingNewer) {
      trace("pagination.request", { direction: "newer", distanceToLatest });
      void loadNewerTurns(sessionId);
    }
  }, [loadNewerTurns, loadOlderTurns, measureVisibleRows, sessionId, setFollowingTail, targetIsLatestMessage, trace, view.hasMoreNewer, view.hasMoreOlder, view.loadingNewer, view.loadingOlder]);

  const handleContentSizeChange = useCallback((width: number, height: number) => {
    trace("list.contentSize", { width, height });
    measureVisibleRows();
    const pending = pendingScrollSequence.current;
    if (pending !== null) {
      scrollToTurn(pending);
      if (pendingScrollSequence.current !== null) return;
      initialScrollDone.current = true;
      return;
    }
    requestInitialScroll();
    requestFollowTail();
  }, [measureVisibleRows, requestFollowTail, requestInitialScroll, scrollToTurn, trace]);

  const handleScrollBeginDrag = useCallback(() => {
    trace("list.dragBegin");
    userDraggingRef.current = true;
    momentumScrollingRef.current = false;
    if (followTailFrameRef.current !== null) {
      cancelAnimationFrame(followTailFrameRef.current);
      followTailFrameRef.current = null;
    }
    cancelTurnScroll();
  }, [cancelTurnScroll, trace]);

  const handleScrollEndDrag = useCallback((event: ChatScrollEvent) => {
    trace("list.dragEnd", { velocityY: event.nativeEvent.velocity?.y, offsetY: event.nativeEvent.contentOffset.y });
    const velocityY = event.nativeEvent.velocity?.y ?? 0;
    if (Math.abs(velocityY) >= 0.05) {
      momentumScrollingRef.current = true;
      return;
    }
    userDraggingRef.current = false;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const { distanceToLatest } = chatListDistances(contentOffset.y, contentSize.height, layoutMeasurement.height);
    setFollowingTail(nextChatTailFollowing({ currentlyFollowing: followingTailRef.current, distanceToBottom: distanceToLatest, userInteracting: false, pendingTarget: pendingScrollSequence.current !== null || turnScrollTargetRef.current !== null }));
    requestFollowTail();
  }, [requestFollowTail, setFollowingTail, trace]);

  const handleMomentumScrollBegin = useCallback(() => {
    trace("list.momentumBegin");
    if (userDraggingRef.current) momentumScrollingRef.current = true;
  }, [trace]);

  const handleMomentumScrollEnd = useCallback((event: ChatScrollEvent) => {
    trace("list.momentumEnd", { offsetY: event.nativeEvent.contentOffset.y });
    userDraggingRef.current = false;
    momentumScrollingRef.current = false;
    if (pendingScrollSequence.current !== null) return;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const { distanceToLatest } = chatListDistances(contentOffset.y, contentSize.height, layoutMeasurement.height);
    setFollowingTail(nextChatTailFollowing({ currentlyFollowing: followingTailRef.current, distanceToBottom: distanceToLatest, userInteracting: false, pendingTarget: pendingScrollSequence.current !== null || (turnScrollTargetRef.current !== null && !targetIsLatestMessage()) }));
    requestFollowTail();
  }, [requestFollowTail, setFollowingTail, targetIsLatestMessage, trace]);

  const handleCopyMessage = useCallback((text: string) => {
    void copyMessageText(text).catch((error) => {
      showToast({ title: t("chat.copyFailed.title"), message: error instanceof Error ? error.message : t("chat.copyFailed.body"), tone: "danger" });
    });
  }, [showToast, t]);

  const forkMessage = useCallback(async (message: MessageRecord) => {
    const turnId = message.meta?.turnId;
    if (!spaceId || typeof turnId !== "string" || forkingTurnId) return;
    setForkingTurnId(turnId);
    try {
      const turn = view.turns.find((item) => item.id === turnId);
      if (!turn) throw new Error(t("chat.forkUnavailable"));
      const response = await forkSession(spaceId, sessionId, turn);
      void refreshHome();
      router.push({ pathname: "/chat/[sessionId]", params: { sessionId: response.id } });
    } catch (error) {
      showToast({ title: t("chat.forkFailed.title"), message: error instanceof Error ? error.message : t("chat.forkFailed.body"), tone: "danger" });
    } finally {
      setForkingTurnId(null);
    }
  }, [forkSession, forkingTurnId, refreshHome, router, sessionId, showToast, spaceId, t, view.turns]);

  const submit = async () => {
    if ((!input.trim() && attachments.length === 0) || view.sending) return;
    const text = input;
    const files = attachments;
    const transitionText = text.trim() || files.map((file) => file.name).join(", ");
    const transitionStartedAt = new Date().toISOString();
    recordDebugEvent("chat.send.pressed", { hasText: Boolean(text.trim()), attachmentCount: files.length, keyboardExpected: true });
    setTransitionMessageKey(null);
    cancelTurnScroll();
    setFollowingTail(true);
    requestFollowTail(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    composerRef.current?.measureInWindow((composerX, composerY, composerWidth, composerHeight) => {
      listContainerRef.current?.measureInWindow((listX, listY) => { recordDebugEvent("chat.send_transition.source_measured", { x: composerX - listX, y: composerY - listY, width: composerWidth, height: composerHeight }); setSendTransition({ text: transitionText, startedAt: transitionStartedAt, sourceX: composerX - listX + Math.max(16, composerWidth - 60), sourceY: composerY - listY + Math.min(composerHeight, 58) / 2 - 5, targetX: 0, targetY: 0, targetHeight: 0 }); });
    });
    recordDebugEvent("chat.keyboard.dismiss_requested");
    Keyboard.dismiss();
    setInput("");
    setAttachments([]);
    recordDebugEvent("chat.send.composer_cleared");
    try {
      const requestModel = modelOverride ? selectedModel : recordedModel;
      await sendMessage(sessionId, text, files, requestModel ? { model: requestModel } : undefined);
      setSendFeedback("success");
      setTimeout(() => setSendFeedback("idle"), 700);
    } catch {
      recordDebugEvent("chat.send.transition_cancelled");
      setInput(text);
      setAttachments(files);
      setTransitionMessageKey(null);
      setSendTransition(null);
    } finally {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
      recordDebugEvent("chat.send.transition_cleanup_scheduled", { delayMs: 560 });
      transitionTimerRef.current = setTimeout(() => {
        transitionTimerRef.current = null;
        recordDebugEvent("chat.send.transition_cleanup");
        setSendTransition(null);
      }, 560);
    }
  };

  useEffect(() => () => { if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current); }, []);

  // FlatList and its cells are PureComponents: bailing out depends on every prop keeping its
  // identity. These are stable across stream batches, so a live turn no longer re-renders every
  // mounted row (the live step list subscribes on its own instead).
  const streamTurnId = view.stream?.turnId ?? null;
  const keyExtractor = useCallback((item: MessageRecord) => `${turnSequenceForMessage(item) ?? item.id}:${item.role}`, []);
  const listContentStyle = useMemo(() => ({ paddingTop: headerHeight + 12, paddingBottom: footerHeight + 12, flexGrow: messages.length === 0 ? 1 : undefined }), [footerHeight, headerHeight, messages.length]);
  const listIndicatorInsets = useMemo(() => ({ top: headerHeight, bottom: footerHeight }), [footerHeight, headerHeight]);
  // Chronological list: anchoring on data changes keeps the reading position when older turns are
  // prepended. `undefined` keeps Legend's default size stabilization.
  const maintainVisiblePosition = useMemo(() => (followingTail ? undefined : { data: true }), [followingTail]);
  const handleListLayout = useCallback((event: LayoutChangeEvent) => {
    trace("list.layout", { ...event.nativeEvent.layout });
    setListWidth(event.nativeEvent.layout.width);
    measureVisibleRows();
  }, [measureVisibleRows, trace]);
  const handleListRefresh = useCallback(() => { void refreshSession(sessionId); }, [refreshSession, sessionId]);
  const renderMessage = useCallback(({ item, index }: { item: MessageRecord; index: number }) => {
    const chronologicalIndex = index;
    const isTransitionMessage = transitionMessage
      ? sendTransitionKey(item) === sendTransitionKey(transitionMessage)
      : item.role === "user" && item.meta?.optimistic === true && sendTransition?.text === messageText(item) && item.createdAt >= sendTransition.startedAt;
    const sequence = turnSequenceForMessage(item);
    const older = messages[index - 1];
    const olderSequence = older ? turnSequenceForMessage(older) : null;
    const showTurnMarker = sequence !== null && sequence !== olderSequence;
    const turn = sequence === null ? null : turnIndexBySequence.get(sequence) ?? null;
    const messageTurn = typeof item.meta?.turnId === "string" ? turnsById.get(item.meta.turnId) ?? null : null;
    const sequenceTurns = item.role === "user" && sequence !== null ? turnsBySequence.get(sequence) : undefined;
    return <View ref={(row) => trackRow(`${turnSequenceForMessage(item) ?? item.id}:${item.role}`, row)} collapsable={false} onLayout={(event) => { if (chatScrollTrace.isRecording()) trace("row.layout", { message: chatScrollTrace.alias("message", item.id), index, sequence, ...event.nativeEvent.layout }); if (chronologicalIndex >= 0) measurements.measure(measuredMessages[chronologicalIndex]!, event.nativeEvent.layout.height); }}>{showTurnMarker ? <TurnMarker sequence={sequence} status={turn?.status} /> : null}{isTransitionMessage ? <SendBubbleMotion transition={sendTransition} transitionKey={sendTransitionKey(item)} message={item} local={item.meta?.optimistic === true} spaceId={spaceId} onCopy={handleCopyMessage} bubbleRef={sendBubbleRef} onBubbleLayout={() => { setTransitionMessageKey((current) => current ?? sendTransitionKey(item)); sendBubbleRef.current?.measureInWindow((bubbleX, bubbleY, _bubbleWidth, bubbleHeight) => listContainerRef.current?.measureInWindow((listX, listY) => setSendTransition((current) => { if (!current || current.text !== messageText(item)) return current; const next = { ...current, targetX: bubbleX - listX - 12, targetY: bubbleY - listY - 5, targetHeight: bubbleHeight }; if (Math.abs(current.targetX - next.targetX) < 1 && Math.abs(current.targetY - next.targetY) < 1 && Math.abs(current.targetHeight - next.targetHeight) < 1) return current; recordDebugEvent("chat.send_transition.target_measured", { message: chatScrollTrace.alias("message", item.id), x: bubbleX - listX, y: bubbleY - listY, width: _bubbleWidth, height: bubbleHeight }); return next; }))); }} /> : <MessageBubble message={item} local={item.meta?.optimistic === true && !isTransitionMessage} onCopy={handleCopyMessage} onFork={messageTurn && isTerminalTurnStatus(messageTurn.status) ? forkMessage : undefined} forkDisabled={forkingTurnId !== null} forking={forkingTurnId === turn?.id} spaceId={spaceId || null} />}{sequenceTurns?.map((entry) => isActiveTurnStatus(entry.status) || entry.id === streamTurnId ? <LiveTurnProcess key={entry.id} sessionId={sessionId} turn={entry} client={client} spaceId={spaceId} /> : <TurnProcess key={entry.id} turn={entry} client={client} spaceId={spaceId} />)}</View>;
  }, [client, forkMessage, forkingTurnId, handleCopyMessage, measuredMessages, measurements, messages, sendTransition, sessionId, spaceId, streamTurnId, trace, transitionMessage, trackRow, turnIndexBySequence, turnsById, turnsBySequence]);

  if (view.loading && !session && view.messages.length === 0 && view.turns.length === 0) return <Screen edgeToEdge><EdgeHeader onLayout={onHeaderLayout}><TopBar transparent title={t("chat.title")} onBack={() => router.back()} /></EdgeHeader><View style={{ flex: 1, paddingTop: headerHeight }}><ChatThreadPlaceholder kind="opening" /></View></Screen>;
  return <Screen keyboard edgeToEdge>
    <View style={{ flex: 1 }} accessibilityElementsHidden={moreOpen} importantForAccessibility={moreOpen ? "no-hide-descendants" : "auto"}>
    <SpacePanels edgeToEdge key={spaceId || sessionId} spaceId={spaceId} spaceName={spaceName} sessions={spaceSessions} client={client} activePanel={activePanel} onActivePanelChange={setActivePanel} onOpenSession={(nextSessionId, target) => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: nextSessionId, ...(target?.turn != null ? { turn: String(target.turn) } : {}), ...(target?.turnId ? { turnId: target.turnId } : {}) } })} onNewChat={() => { if (spaceId) router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId } }); }} onOpenFile={(path) => { if (spaceId) router.push({ pathname: "/space/[spaceId]/file", params: { spaceId, path } }); }} onOpenFilesPage={() => { if (spaceId) router.push({ pathname: "/space/[spaceId]/files", params: { spaceId } }); }}>
      <View style={{ flex: 1, minHeight: 0 }}>
        <EdgeHeader onLayout={onHeaderLayout}>
        <TopBar transparent title={session ? displaySessionTitle(session) : t("chat.title")} subtitle={spaceName} onBack={() => router.back()} actions={<><IconButton name="list-tree" label={t("chat.turns.open")} size={38} onPress={() => setTurnNavigatorOpen(true)} disabled={view.turnIndex.length === 0 && view.loading} /><View ref={moreButtonRef} collapsable={false}><IconButton name="more" label={t("chat.more")} size={38} onPress={() => setMoreOpen(true)} /></View></>} />
        <ConnectionBanner state={connectionState} />
        {view.error ? <Pressable onPress={() => void refreshSession(sessionId)} style={({ pressed }) => ({ marginHorizontal: 16, marginTop: 12, padding: 11, borderRadius: 12, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.dangerSoft, flexDirection: "row", alignItems: "center", gap: 8 })}><AppIcon name="alert" size={16} color={theme.colors.danger} /><Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{view.error}</Text><Text style={[typography.caption, { color: theme.colors.danger }]}>{t("common.retry")}</Text></Pressable> : null}
        </EdgeHeader>
        <View ref={listContainerRef} collapsable={false} style={{ flex: 1, minHeight: 0 }}>
        {/* Android selectable text must not reposition the timeline when it gains focus. Explicit turn/tail scrolling remains enabled. */}
        <LegendList
          {...traceTouches}
          ref={listRef}
          data={messages}
          alignItemsAtEnd
          estimatedItemSize={FALLBACK_ROW_HEIGHT}
          // Android scrolls a focused selectable text into view; selecting a message must not
          // move the timeline. Explicit turn/tail scrolling stays enabled.
          scrollsChildToFocus={false}
          onLayout={handleListLayout}
          keyExtractor={keyExtractor}
          renderItem={renderMessage}
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={maintainVisiblePosition}
          viewabilityConfig={messageViewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
          scrollEventThrottle={100}
          onScroll={handleScroll}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          onMomentumScrollBegin={handleMomentumScrollBegin}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          contentInsetAdjustmentBehavior="never"
          progressViewOffset={headerHeight}
          scrollIndicatorInsets={listIndicatorInsets}
          contentContainerStyle={listContentStyle}
          onContentSizeChange={handleContentSizeChange}
          onRefresh={handleListRefresh}
          refreshing={view.refreshing}
          ListHeaderComponent={view.hasMoreOlder ? <Pressable accessibilityRole="button" accessibilityLabel={t("chat.loadOlder")} disabled={view.loadingOlder} onPress={() => void loadOlderTurns(sessionId)} style={({ pressed }) => ({ minHeight: 42, marginHorizontal: 16, marginTop: 8, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}>{view.loadingOlder ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>{t("chat.loadOlder")}</Text>}</Pressable> : null}
          ListFooterComponent={<View>{view.hasMoreNewer ? <Pressable accessibilityRole="button" accessibilityLabel={t("chat.loadNewer")} disabled={view.loadingNewer} onPress={() => void loadNewerTurns(sessionId)} style={({ pressed }) => ({ minHeight: 42, marginHorizontal: 16, marginBottom: 8, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}>{view.loadingNewer ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>{t("chat.loadNewer")}</Text>}</Pressable> : null}{liveStreamReady && liveStream && view.stream ? <><StreamingTurnProcess messages={view.turns.some((turn) => turn.id === view.stream?.turnId) ? [] : view.stream.intermediateMessages} /><StreamCard content={view.stream.contentBlocks} status={view.stream.status} runtimePhase={view.stream.runtimePhase} runtimeModel={view.stream.runtimeModel} /></> : view.sending && !liveStream ? <StreamCard content={[]} status="pending" /> : null}</View>}
        />
        {threadPlaceholder ? <View pointerEvents="none" style={{ position: "absolute", top: headerHeight, right: 0, bottom: footerHeight, left: 0 }}><ChatThreadPlaceholder kind={threadPlaceholder} /></View> : null}

        {!followingTail ? <Pressable accessibilityRole="button" accessibilityLabel={t("chat.jumpLatest")} onPress={() => { cancelTurnScroll(); setFollowingTail(true); requestFollowTail(true); }} style={({ pressed }) => ({ position: "absolute", right: 16, bottom: footerHeight + 12, zIndex: 4, width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised, borderWidth: 1, borderColor: theme.colors.border, shadowColor: theme.colors.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.22, shadowRadius: 5, elevation: 4 })}><AppIcon name="arrow-down" size={18} color={theme.colors.accent} /></Pressable> : null}
        </View>
        <EdgeFooter onLayout={onFooterLayout}>
        {queuedFollowups.length > 0 ? <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6, gap: 6 }}>
          <Text style={[typography.micro, { color: theme.colors.textMuted }]}>{t("chat.followups", { count: queuedFollowups.length })}</Text>
          {queuedFollowups.map((turn) => {
            const pending = pendingFollowupAction === turn.id;
            const preview = followupPreviewText(turn);
            return <View key={turn.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10, paddingLeft: 10, paddingRight: 6, paddingVertical: 5, backgroundColor: theme.colors.surface }}>
              <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.text, flex: 1 }]}>{preview}</Text>
              {pending ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <>
                <Pressable accessibilityRole="button" accessibilityLabel={t("chat.steerAccessibility", { preview })} onPress={() => void runFollowupAction(turn.id, "steer")} hitSlop={6} style={({ pressed }) => ({ paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.accentSoft })}><Text style={[typography.caption, { color: theme.colors.accent }]}>{t("chat.steerNow")}</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={t("chat.cancelFollowup", { preview })} onPress={() => void runFollowupAction(turn.id, "cancel")} hitSlop={6} style={({ pressed }) => ({ paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}><Text style={[typography.caption, { color: theme.colors.textMuted }]}>{t("common.cancel")}</Text></Pressable>
              </>}
            </View>;
          })}
        </View> : null}
        {attachments.length > 0 ? <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 7, backgroundColor: theme.colors.background }}>{attachments.map((attachment, index) => <AttachmentChip key={`${attachment.uri}-${index}`} name={attachment.name} onRemove={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</View> : null}
        {voice.partial || voice.error ? <View style={{ paddingHorizontal: 16, paddingTop: 5, backgroundColor: theme.colors.background }}><Text style={[typography.caption, { color: voice.error ? theme.colors.danger : theme.colors.textMuted }]}>{voice.error ? voice.error : t("chat.listening", { text: voice.partial })}</Text></View> : null}
        <ComposerInput anchorRef={composerRef} attachmentMenuOpen={attachmentMenuOpen} modelMenuOpen={modelSelectorOpen} sendFeedback={sendFeedback} value={input} onChangeText={setInput} onSend={() => void submit()} onStop={() => void stopGeneration()} onAttach={() => { setModelSelectorOpen(false); setAttachmentMenuOpen(true); }} sending={view.sending} onVoice={() => voice.isRecording ? voice.stop() : void voice.start()} onModelPress={() => { setAttachmentMenuOpen(false); void Promise.all([loadModels(), loadModelStatus()]).catch(() => undefined); setModelSelectorOpen(true); }} modelLabel={modelTriggerLabel} modelStatus={activeStatus} voiceActive={voice.isRecording} voiceStarting={voice.isStarting} disabled={view.loading || stopping} running={running} hasAttachment={attachments.length > 0} placeholder={running ? t("ui.composer.working") : t("ui.composer.placeholder")} />
        </EdgeFooter>
        {labelSheetOpen && client && session && spaceId ? <SessionLabelSheet client={client} spaceId={spaceId} session={session} labels={chatLabels} labelsError={null} onLabelsReload={() => { if (client && spaceId) void fetchSessionLabels(client, spaceId).then((tree) => setChatLabels(toUserSessionLabels(tree))).catch(() => undefined); }} onClose={() => setLabelSheetOpen(false)} onChanged={() => undefined} /> : null}
        {attachmentMenuOpen ? <AttachmentMenu anchorRef={composerRef} onClose={() => setAttachmentMenuOpen(false)} onCamera={() => void takePhoto()} onPhotos={() => void pickPhotos()} onFile={() => void pickAttachments()} /> : null}
        <TurnNavigatorSheet visible={turnNavigatorOpen} turns={view.turnIndex} currentSequence={currentTurnSequence} loading={view.turnIndexLoading} loadingSequence={loadingSequence} onClose={() => setTurnNavigatorOpen(false)} onJump={(sequence) => handleTurnJump(sequence)} onRetry={() => void loadTurnIndex(sessionId, { force: true }).catch(() => undefined)} />
        {modelSelectorOpen ? <ModelSelectorMenu anchorRef={composerRef} models={models} loading={modelsLoading} error={modelsError || modelStatusError} modelStatus={modelStatus?.models ?? null} modelStatusLoading={modelStatusLoading} currentModel={modelOverride ? selectedModel : recordedModel} onClose={() => setModelSelectorOpen(false)} onRetry={() => void Promise.all([loadModels({ force: true }), loadModelStatus({ force: true })]).catch(() => undefined)} onSelect={(model) => { setSelectedModel(model); setModelOverride(true); setModelSelectorOpen(false); }} /> : null}
        <AdaptiveSheet visible={notice !== null} title={notice?.title ?? t("common.notice")} onClose={() => setNotice(null)} scrollable={false} testID="chat-notice-sheet"><Text style={[typography.body, { color: theme.colors.textSecondary }]}>{notice?.message ?? ""}</Text></AdaptiveSheet>
        <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}><View style={{ flex: 1, justifyContent: "center", padding: 22, backgroundColor: "rgba(0,0,0,0.6)" }}><View style={{ borderRadius: 18, padding: 18, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }}><Text style={[typography.heading, { color: theme.colors.text }]}>{t("chat.rename.title")}</Text><TextInput autoFocus value={renameValue} onChangeText={setRenameValue} maxLength={80} placeholder={t("chat.rename.placeholder")} placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 48, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, paddingHorizontal: 12, marginTop: 14 }]} /><View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 }}><Pressable onPress={() => setRenameOpen(false)} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center" }}><Text style={[typography.bodyMedium, { color: theme.colors.textMuted }]}>{t("common.cancel")}</Text></Pressable><PrimaryButton label={t("common.save")} onPress={() => void saveRename()} style={{ minHeight: 44, paddingHorizontal: 16 }} /></View></View></View></Modal>
      </View>
    </SpacePanels>
    </View>
    {moreOpen ? <AnchoredActionMenu
      anchorRef={moreButtonRef}
      title={session ? displaySessionTitle(session) : t("chat.title")}
      testID="chat-actions-menu"
      onClose={closeMore}
      actions={[
        ...(tracing ? [{ icon: "activity" as const, title: "Scroll Diagnostics", onPress: () => { trace("experiment.mark", { origin: "chatMenu" }); router.push("/debug/chat-scroll"); } }] : []),
        { icon: "share", title: t("chat.actions.share"), onPress: () => void shareChat() },
        { icon: "messages", title: t("chat.actions.openChats"), disabled: !spaceId, onPress: () => setActivePanel("chat") },
        { icon: "folder-open", title: t("chat.actions.openFiles"), disabled: !spaceId, onPress: () => setActivePanel("files") },
        { icon: "tag", title: t("chat.actions.labels"), disabled: !client || !spaceId, onPress: openLabelSheet },
        { icon: "square-pen", title: t("chat.actions.rename"), onPress: openRename },
      ]}
    /> : null}
  </Screen>;
}

/**
 * Live step list for an active turn. Subscribing to the stream here instead of inside
 * `renderItem` keeps the row list's callback identity stable, so stream batches stop
 * re-rendering every mounted cell. The fallback matches the persisted turn process.
 */
function LiveTurnProcess({ sessionId, turn, client, spaceId }: { sessionId: string; turn: SessionTurnRecord; client: CohubClient | null; spaceId: string }) {
  const { state } = useApp();
  const stream = state.sessionViews[sessionId]?.stream ?? null;
  if (stream?.turnId === turn.id) return <StreamingTurnProcess messages={stream.intermediateMessages} />;
  return <TurnProcess turn={turn} client={client} spaceId={spaceId} />;
}

function SendBubbleMotion({ transition, transitionKey, message, local, spaceId, onCopy, bubbleRef, onBubbleLayout }: { transition: SendTransition | null; transitionKey: string; message: MessageRecord; local: boolean; spaceId?: string; onCopy?: (text: string) => void; bubbleRef: React.RefObject<View | null>; onBubbleLayout?: () => void }) {
  const pop = useSharedValue(0);
  const travel = useSharedValue(0);
  const animationStarted = useRef(false);
  const animationTimers = useRef<{ pop: ReturnType<typeof setTimeout>; settle: ReturnType<typeof setTimeout> } | null>(null);
  const transitionAlias = chatScrollTrace.alias("message", transitionKey);
  useEffect(() => {
    recordDebugEvent("chat.send_transition.mounted", { message: transitionAlias });
    return () => {
      if (animationTimers.current) {
        clearTimeout(animationTimers.current.pop);
        clearTimeout(animationTimers.current.settle);
      }
      recordDebugEvent("chat.send_transition.unmounted", { message: transitionAlias });
    };
  }, [transitionAlias, transitionKey]);
  const targetHeight = transition?.targetHeight ?? 0;
  useEffect(() => {
    if (!transition || targetHeight <= 0 || animationStarted.current) return;
    animationStarted.current = true;
    recordDebugEvent("chat.send_transition.started", { message: transitionAlias, sourceX: transition.sourceX, sourceY: transition.sourceY, targetX: transition.targetX, targetY: transition.targetY, targetHeight });
    pop.value = withSequence(withTiming(0.55, { duration: 110, easing: Easing.out(Easing.cubic) }), withSpring(1, { duration: 260, dampingRatio: 0.72 }));
    travel.value = withDelay(70, withTiming(1, { duration: 390, easing: Easing.out(Easing.cubic) }));
    animationTimers.current = {
      pop: setTimeout(() => recordDebugEvent("chat.send_transition.pop_peak", { message: transitionAlias }), 110),
      settle: setTimeout(() => recordDebugEvent("chat.send_transition.settled", { message: transitionAlias }), 470),
    };
  }, [pop, targetHeight, travel, transition, transitionAlias, transitionKey]);
  const style = useAnimatedStyle(() => ({
    opacity: transition && targetHeight > 0 ? interpolate(pop.value, [0, 0.35, 1], [0, 1, 1]) : 1,
    transform: transition && targetHeight > 0 ? [
      { translateX: (transition.sourceX - transition.targetX) * (1 - travel.value) },
      { translateY: (transition.sourceY - transition.targetY) * (1 - travel.value) },
      { scale: interpolate(pop.value, [0, 0.55, 1], [0.94, 1.045, 1]) },
    ] : [],
  }));
  return <MessageBubble message={message} local={local} onCopy={onCopy} spaceId={spaceId} bubbleRef={bubbleRef} onBubbleLayout={onBubbleLayout} animatedStyle={transition ? style : undefined} />;
}

function ChatThreadPlaceholder({ kind }: { kind: "opening" | "empty" }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  if (kind === "opening") {
    return (
      <View accessible accessibilityLabel={t("chat.opening")} style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 28 }}>
        <ActivityIndicator size="small" color={theme.colors.accent} />
        <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 14 }]}>{t("chat.placeholder.opening")}</Text>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 28 }}>
      <View style={{ width: 52, height: 52, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accentSoft }}>
        <AppIcon name="sparkles" size={23} color={theme.colors.accent} />
      </View>
      <Text style={[typography.heading, { color: theme.colors.text, marginTop: 14, textAlign: "center" }]}>{t("chat.placeholder.empty.title")}</Text>
      <Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center", marginTop: 6, maxWidth: 290 }]}>{t("chat.placeholder.empty.body")}</Text>
    </View>
  );
}

function TurnMarker({ sequence, status }: { sequence: number; status?: string }) {
  const theme = useAppTheme();
  const color = status === "failed" ? theme.colors.danger : status === "running" || status === "queued" ? theme.colors.warning : theme.colors.textFaint;
  return <View onLayout={(event) => recordDebugEvent("chat.turn_marker.layout", { sequence, status: status ?? null, ...event.nativeEvent.layout })} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 13, paddingBottom: 2 }}><View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} /><Text style={[typography.micro, { color }]}>#{sequence}</Text><View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} /></View>;
}

function DraftChatContent({ spaceId }: { spaceId: string }) {
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const showToast = useToast();
  const { state, client, connectionState, sendNewMessage, getAccessToken, loadModels, loadModelStatus, models, modelsLoading, modelsError, modelStatus, modelStatusLoading, modelStatusError } = useApp();
  const space = state.spaces.find((item) => item.id === spaceId) ?? null;
  const { headerHeight, onHeaderLayout } = useEdgeChrome();
  const composerRef = useRef<View>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ChatModelSelection | null>(null);
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const voice = useNativeVoiceInput({ getAccessToken, onFinal: (text) => setInput((current) => current.trim() ? `${current.trim()} ${text}` : text) });
  const appendAttachments = (next: AttachmentDraft[]) => setAttachments((current) => [...current, ...next].slice(0, 6));
  const pickAttachments = async () => { setAttachmentMenuOpen(false); try { const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true }); if (result.canceled) return; appendAttachments(result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType || "application/octet-stream", size: asset.size ?? 0 }))); } catch (error) { showToast({ title: t("chat.attachmentUnavailable.title"), message: error instanceof Error ? error.message : t("chat.attachmentUnavailable.body"), tone: "danger" }); } };
  const pickPhotos = async () => { setAttachmentMenuOpen(false); try { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) { showToast({ title: t("chat.photoOff.title"), message: t("chat.photoOff.body"), tone: "danger" }); return; } const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 0.88 }); if (result.canceled) return; appendAttachments(result.assets.map((asset, index) => ({ uri: asset.uri, name: asset.fileName || `image-${index + 1}.jpg`, mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 }))); } catch (error) { showToast({ title: t("chat.photoPickerUnavailable.title"), message: error instanceof Error ? error.message : t("chat.photoPickerUnavailable.body"), tone: "danger" }); } };
  const takePhoto = async () => { setAttachmentMenuOpen(false); try { const permission = await ImagePicker.requestCameraPermissionsAsync(); if (!permission.granted) { showToast({ title: t("chat.cameraOff.title"), message: t("chat.cameraOff.body"), tone: "danger" }); return; } const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.88 }); if (result.canceled) return; const asset = result.assets[0]; if (asset) appendAttachments([{ uri: asset.uri, name: asset.fileName || "camera-photo.jpg", mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 }]); } catch (error) { showToast({ title: t("chat.cameraUnavailable.title"), message: error instanceof Error ? error.message : t("chat.cameraUnavailable.body"), tone: "danger" }); } };
  const submit = async () => {
    if (!space || sending || (!input.trim() && attachments.length === 0)) return;
    const text = input;
    const files = attachments;
    setInput("");
    setAttachments([]);
    setSending(true);
    try { const session = await sendNewMessage(space.id, text, files, { model: selectedModel }); router.replace({ pathname: "/chat/[sessionId]", params: { sessionId: session.id } }); } catch (error) { setInput(text); setAttachments(files); showToast({ title: t("chat.startFailed.title"), message: error instanceof Error ? error.message : t("chat.startFailed.body"), tone: "danger" }); } finally { setSending(false); }
  };
  if (!space) return <Screen><TopBar title={t("chat.spaceUnavailable")} onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center" }]}>{t("chat.spaceUnavailable.body")}</Text></View></Screen>;
  const spaceName = displaySpaceName(space);
  const spaceSessions = state.sessions.filter((item) => item.spaceId === space.id);
  const modelLabel = selectedModel?.name || selectedModel?.id || t("chat.model.automatic");
  const modelTriggerLabel = selectedModel?.thinkingLevel ? `${modelLabel} · ${formatThinkingLevel(selectedModel.thinkingLevel)}` : modelLabel;
  const selectedStatus = selectedModel ? modelAvailabilityLevel(modelStatus?.models[selectedModel.id]) : "unknown";
  return <Screen keyboard edgeToEdge>
    <SpacePanels edgeToEdge key={space.id} spaceId={space.id} spaceName={spaceName} sessions={spaceSessions} client={client} activePanel={activePanel} onActivePanelChange={setActivePanel} onOpenSession={(nextSessionId, target) => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: nextSessionId, ...(target?.turn != null ? { turn: String(target.turn) } : {}), ...(target?.turnId ? { turnId: target.turnId } : {}) } })} onNewChat={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId: space.id } })} onOpenFile={(path) => router.push({ pathname: "/space/[spaceId]/file", params: { spaceId: space.id, path } })} onOpenFilesPage={() => router.push({ pathname: "/space/[spaceId]/files", params: { spaceId: space.id } })}>
      <View style={{ flex: 1, minHeight: 0 }}>
        <EdgeHeader onLayout={onHeaderLayout}>
        <TopBar transparent title={spaceName} onBack={() => router.back()} actions={<><IconButton name="messages" label={t("chat.actions.openChats")} size={38} onPress={() => setActivePanel("chat")} /><IconButton name="folder-open" label={t("chat.actions.openFiles")} size={38} onPress={() => setActivePanel("files")} /></>} />
        <ConnectionBanner state={connectionState} />
        </EdgeHeader>
        <View style={{ flex: 1, minHeight: 0, paddingTop: headerHeight }}>
          <View style={{ flex: 1, minHeight: 0, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingBottom: 18 }}><AppIcon name="sparkles" size={28} color={theme.colors.textMuted} /><Text style={[typography.heading, { color: theme.colors.text, marginTop: 15, textAlign: "center" }]}>{t("chat.draft.title")}</Text></View>
          {attachments.length > 0 ? <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 7, backgroundColor: theme.colors.background }}>{attachments.map((attachment, index) => <AttachmentChip key={`${attachment.uri}-${index}`} name={attachment.name} onRemove={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</View> : null}
          {voice.partial || voice.error ? <View style={{ paddingHorizontal: 16, paddingTop: 5, backgroundColor: theme.colors.background }}><Text style={[typography.caption, { color: voice.error ? theme.colors.danger : theme.colors.textMuted }]}>{voice.error ? voice.error : t("chat.listening", { text: voice.partial })}</Text></View> : null}
          <ComposerInput anchorRef={composerRef} attachmentMenuOpen={attachmentMenuOpen} modelMenuOpen={modelSelectorOpen} value={input} onChangeText={setInput} onSend={() => void submit()} onAttach={() => { setModelSelectorOpen(false); setAttachmentMenuOpen(true); }} sending={sending} onVoice={() => voice.isRecording ? voice.stop() : void voice.start()} onModelPress={() => { setAttachmentMenuOpen(false); void Promise.all([loadModels(), loadModelStatus()]).catch(() => undefined); setModelSelectorOpen(true); }} modelLabel={modelTriggerLabel} modelStatus={selectedStatus} voiceActive={voice.isRecording} voiceStarting={voice.isStarting} disabled={sending} hasAttachment={attachments.length > 0} placeholder={sending ? t("chat.draft.starting") : t("ui.composer.placeholder")} />
        </View>
        {modelSelectorOpen ? <ModelSelectorMenu anchorRef={composerRef} models={models} loading={modelsLoading} error={modelsError || modelStatusError} modelStatus={modelStatus?.models ?? null} modelStatusLoading={modelStatusLoading} currentModel={selectedModel} onClose={() => setModelSelectorOpen(false)} onRetry={() => void Promise.all([loadModels({ force: true }), loadModelStatus({ force: true })]).catch(() => undefined)} onSelect={(model) => { setSelectedModel(model); setModelSelectorOpen(false); }} /> : null}
        {attachmentMenuOpen ? <AttachmentMenu anchorRef={composerRef} onClose={() => setAttachmentMenuOpen(false)} onCamera={() => void takePhoto()} onPhotos={() => void pickPhotos()} onFile={() => void pickAttachments()} /> : null}
        <AdaptiveSheet visible={notice !== null} title={notice?.title ?? t("common.notice")} onClose={() => setNotice(null)} scrollable={false} testID="new-chat-notice-sheet"><Text style={[typography.body, { color: theme.colors.textSecondary }]}>{notice?.message ?? ""}</Text></AdaptiveSheet>
      </View>
    </SpacePanels>
  </Screen>;
}

function MissingChat() {
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  return <Screen><TopBar title={t("chat.title")} onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>{t("chat.missing")}</Text></View></Screen>;
}
