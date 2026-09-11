import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, Share, Text, TextInput, View, useWindowDimensions, type ViewToken } from "react-native";
import { AdaptiveSheet, SheetAction } from "@/src/components/AdaptiveSheet";
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
import { CHAT_PAGE_THRESHOLD, invertedListDistances, nextChatTailFollowing, reverseListIndex } from "@/src/data/chat-scroll";
import { chatScrollTrace, type TraceFields } from "@/src/data/chat-scroll-trace";
import { useChatScrollTrace, useTraceTouches } from "@/src/components/use-chat-scroll-trace";
import { cancelQueuedFollowup, followupPreviewText, queuedFollowupTurns, steerQueuedFollowup } from "@/src/data/followup-queue";
import { isLiveStreamStatus, isTerminalTurnStatus, shouldShowLiveStream } from "@/src/data/chat-stream";
import { MessageMeasurements } from "@/src/data/chat-rendering";
import type { AttachmentDraft, ChatModelSelection } from "@/src/data/types";
import type { MessageRecord } from "@neta-art/cohub";
import { chatThreadPlaceholder, mergeDisplayMessages, messageIndexForTurn, messagesFromTurns, turnSequenceForMessage, withTurnSequences } from "@/src/data/session-history";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { formatThinkingLevel, modelAvailabilityLevel, requestedThinkingLevel } from "@/src/model-catalog";
import { useNativeVoiceInput } from "@/src/platform/native-voice-input";
import { AppIcon, AttachmentChip, ComposerInput, ConnectionBanner, DetailTopBar, IconButton, PrimaryButton, Screen } from "@/src/ui";
import { displaySessionTitle, displaySpaceName, hasRenderableMessage, isAssistantIntermediate } from "@/src/utils";

type RouteParams = { sessionId?: string | string[]; spaceId?: string | string[]; turn?: string | string[]; turnId?: string | string[] };
const messageViewabilityConfig = { itemVisiblePercentThreshold: 20 };

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
  const composerRef = useRef<View>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
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
  const [currentTurnSequence, setCurrentTurnSequence] = useState<number | null>(null);
  const pendingScrollSequence = useRef<number | null>(null);
  const handledDeepLinkTarget = useRef<string | null>(null);
  const listRef = useRef<FlatList>(null);
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
    scrollsChildToFocus: false,
    ...lastScrollRef.current,
  }), [sessionId]);
  const { recording: tracing, log: trace } = useChatScrollTrace("chat", traceState);
  const traceTouches = useTraceTouches("chat.list", traceState, tracing);
  const traceOffset = useCallback((source: string, options: { offset: number; animated: boolean }) => {
    trace("command.scrollToOffset", { source, ...options, hasList: Boolean(listRef.current) });
    listRef.current?.scrollToOffset(options);
  }, [trace]);
  const traceIndex = useCallback((source: string, options: { index: number; animated: boolean; viewPosition: number; viewOffset: number }) => {
    trace("command.scrollToIndex", { source, ...options, hasList: Boolean(listRef.current) });
    listRef.current?.scrollToIndex(options);
  }, [trace]);
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
      traceOffset("tail.frame", { offset: 0, animated });
      requestAnimationFrame(() => {
        if (!followingTailRef.current || userDraggingRef.current || momentumScrollingRef.current) return;
        traceOffset("tail.secondFrame", { offset: 0, animated: false });
      });
    });
  }, [trace, traceOffset]);
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
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
    const visualTop = ordered.at(-1);
    if (visualTop?.item) setCurrentTurnSequence(turnSequenceForMessage(visualTop.item as { meta: Record<string, unknown> | null }));
  }, [saveSessionReadSequence, sessionId, trace]);
  const session = view.session ?? state.sessions.find((item) => item.id === sessionId) ?? null;
  const sessionSummary = state.sessions.find((item) => item.id === sessionId) ?? null;
  const spaceId = view.space?.id ?? session?.spaceId ?? sessionSummary?.spaceId ?? "";
  const spaceName = view.space ? displaySpaceName(view.space) : sessionSummary?.space?.name || t("space.fallbackName");
  const spaceSessions = useMemo(() => state.sessions.filter((item) => item.spaceId === spaceId), [spaceId, state.sessions]);
  const queuedFollowups = useMemo(() => queuedFollowupTurns(view.turns, view.stream?.turnId), [view.stream?.turnId, view.turns]);
  const queuedFollowupIds = useMemo(() => new Set(queuedFollowups.map((turn) => turn.id)), [queuedFollowups]);
  const messages = useMemo(() => {
    const history = messagesFromTurns(view.turns);
    return withTurnSequences(
      mergeDisplayMessages(history.length > 0 ? history : view.messages, history.length > 0 ? view.messages : [])
        .filter((message) => !isAssistantIntermediate(message) && hasRenderableMessage(message) && !(typeof message.meta?.turnId === "string" && queuedFollowupIds.has(message.meta.turnId))),
      view.turns,
    );
  }, [queuedFollowupIds, view.messages, view.turns]);
  const timeline = useMemo(() => messages.slice().reverse(), [messages]);
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
      inverted: true, maintainVisibleContentPosition: !followingTail,
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
    revision: JSON.stringify([message, index > 0 ? turnSequenceForMessage(messages[index - 1]!) : null]),
  })), [messages]);
  useEffect(() => {
    measurements.configure(`${listWidth}:${fontScale}:${theme.mode}:${textSizeToken}`, measuredMessages);
  }, [measurements, measuredMessages, listWidth, fontScale, textSizeToken, theme.mode]);
  const estimatedOffset = useCallback((timelineIndex: number, averageHeight: number) => {
    const chronologicalIndex = reverseListIndex(timelineIndex, measuredMessages.length);
    const fromOldest = chronologicalIndex < 0 ? 0 : measurements.estimateOffset(measuredMessages, chronologicalIndex, averageHeight);
    const total = measurements.estimateOffset(measuredMessages, measuredMessages.length, averageHeight);
    return 12 + (view.hasMoreNewer ? 50 : 0) + Math.max(0, total - fromOldest);
  }, [measurements, measuredMessages, view.hasMoreNewer]);
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
    traceOffset("initial.latest", { offset: 0, animated: false });
    setFollowingTail(true);
    setCurrentTurnSequence(view.turns.at(-1)?.sequence ?? null);
  }, [hasInitialTurnTarget, messages.length, setFollowingTail, traceOffset, view.historyLoaded, view.turns]);

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
      traceIndex("turn.retryTimer", { index: reverseListIndex(index, messages.length), animated: false, viewPosition: 0.15, viewOffset: 8 });
    }, retry === 0 ? 120 : 180);
  }, [messages.length, targetMessageIndex, trace, traceIndex]);
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
    traceIndex("turn.scrollToTurn", { index: reverseListIndex(index, messages.length), animated: retry === 0, viewPosition: 0.15, viewOffset: 8 });
    scheduleTurnScrollRetry(sequence, retry);
    setCurrentTurnSequence(sequence);
  }, [messages.length, scheduleTurnScrollRetry, setFollowingTail, targetMessageIndex, trace, traceIndex]);

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
    setMoreOpen(false);
    const title = session ? displaySessionTitle(session) : t("chat.title");
    if (!spaceId) {
      showToast({ title: t("chat.shareFailed.title"), message: t("chat.shareFailed.body"), tone: "danger" });
      return;
    }
    const url = `https://cohub.live/spaces/${encodeURIComponent(spaceId)}/sessions/${encodeURIComponent(sessionId)}`;
    await Share.share({ message: `${title}\n${url}`, url, title });
  };
  const openRename = () => { setMoreOpen(false); setRenameValue(session ? displaySessionTitle(session) : ""); setRenameOpen(true); };
  const openLabelSheet = () => {
    setMoreOpen(false);
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
    const { distanceToLatest, distanceToOldest } = invertedListDistances(contentOffset.y, contentSize.height, layoutMeasurement.height);
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
  }, [loadNewerTurns, loadOlderTurns, sessionId, setFollowingTail, targetIsLatestMessage, trace, view.hasMoreNewer, view.hasMoreOlder, view.loadingNewer, view.loadingOlder]);

  const handleContentSizeChange = useCallback((width: number, height: number) => {
    trace("list.contentSize", { width, height });
    const pending = pendingScrollSequence.current;
    if (pending !== null) {
      scrollToTurn(pending);
      if (pendingScrollSequence.current !== null) return;
      initialScrollDone.current = true;
      return;
    }
    requestInitialScroll();
    requestFollowTail();
  }, [requestFollowTail, requestInitialScroll, scrollToTurn, trace]);

  const handleScrollToIndexFailed = useCallback(({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
    trace("turn.indexFailed", { index, averageItemLength });
    const initialUnreadIndex = initialUnreadIndexRef.current;
    if (initialUnreadIndex !== null) {
      const retries = initialUnreadRetriesRef.current;
      if (retries >= 4) {
        initialUnreadIndexRef.current = null;
        return;
      }
      initialUnreadRetriesRef.current = retries + 1;
      traceOffset("unread.estimate", { offset: estimatedOffset(index, averageItemLength), animated: false });
      requestAnimationFrame(() => {
        if (initialUnreadIndexRef.current === initialUnreadIndex) traceIndex("unread.retryFrame", { index: initialUnreadIndex, animated: false, viewPosition: 0.15, viewOffset: 8 });
      });
      return;
    }
    const target = turnScrollTargetRef.current ?? pendingScrollSequence.current;
    if (target === null) return;
    const retries = turnScrollRetriesRef.current.get(target) ?? 0;
    if (retries >= 4) {
      turnScrollRetriesRef.current.delete(target);
      turnScrollTargetRef.current = null;
      if (turnScrollRetryTimerRef.current !== null) {
        clearTimeout(turnScrollRetryTimerRef.current);
        turnScrollRetryTimerRef.current = null;
      }
      return;
    }
    turnScrollRetriesRef.current.set(target, retries + 1);
    traceOffset("turn.estimate", { offset: estimatedOffset(index, averageItemLength), animated: false });
    requestAnimationFrame(() => {
      if (turnScrollTargetRef.current === target) scrollToTurn(target, retries + 1);
    });
  }, [estimatedOffset, scrollToTurn, trace, traceIndex, traceOffset]);

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
    const { distanceToLatest } = invertedListDistances(contentOffset.y, contentSize.height, layoutMeasurement.height);
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
    const { distanceToLatest } = invertedListDistances(contentOffset.y, contentSize.height, layoutMeasurement.height);
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
    cancelTurnScroll();
    setFollowingTail(true);
    requestFollowTail(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInput("");
    setAttachments([]);
    try {
      const requestModel = modelOverride ? selectedModel : recordedModel;
      await sendMessage(sessionId, text, files, requestModel ? { model: requestModel } : undefined);
    } catch { setInput(text); setAttachments(files); }
  };

  if (view.loading && !session && view.messages.length === 0 && view.turns.length === 0) return <Screen><DetailTopBar title={t("chat.title")} onBack={() => router.back()} /><ChatThreadPlaceholder kind="opening" /></Screen>;
  return <Screen keyboard>
    <SpacePanels key={spaceId || sessionId} spaceId={spaceId} spaceName={spaceName} sessions={spaceSessions} client={client} activePanel={activePanel} onActivePanelChange={setActivePanel} onOpenSession={(nextSessionId, target) => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: nextSessionId, ...(target?.turn != null ? { turn: String(target.turn) } : {}), ...(target?.turnId ? { turnId: target.turnId } : {}) } })} onNewChat={() => { if (spaceId) router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId } }); }} onOpenFile={(path) => { if (spaceId) router.push({ pathname: "/space/[spaceId]/file", params: { spaceId, path } }); }} onOpenFilesPage={() => { if (spaceId) router.push({ pathname: "/space/[spaceId]/files", params: { spaceId } }); }}>
      <View style={{ flex: 1, minHeight: 0 }}>
        <DetailTopBar title={session ? displaySessionTitle(session) : t("chat.title")} subtitle={spaceName} onBack={() => router.back()} actions={<><IconButton name="list-tree" label={t("chat.turns.open")} size={38} onPress={() => setTurnNavigatorOpen(true)} disabled={view.turnIndex.length === 0 && view.loading} /><IconButton name="more" label={t("chat.more")} size={38} onPress={() => setMoreOpen(true)} /></>} />
        <ConnectionBanner state={connectionState} />
        {view.error ? <Pressable onPress={() => void refreshSession(sessionId)} style={({ pressed }) => ({ marginHorizontal: 16, marginTop: 12, padding: 11, borderRadius: 12, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.dangerSoft, flexDirection: "row", alignItems: "center", gap: 8 })}><AppIcon name="alert" size={16} color={theme.colors.danger} /><Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{view.error}</Text><Text style={[typography.caption, { color: theme.colors.danger }]}>{t("common.retry")}</Text></Pressable> : null}
        <View style={{ flex: 1, minHeight: 0 }}>
        {/* Android selectable text must not reposition the timeline when it gains focus. Explicit turn/tail scrolling remains enabled. */}
        <FlatList {...traceTouches} ref={listRef} inverted scrollsChildToFocus={false} initialNumToRender={16} maxToRenderPerBatch={8} updateCellsBatchingPeriod={32} windowSize={11} onLayout={(event) => { trace("list.layout", { ...event.nativeEvent.layout }); setListWidth(event.nativeEvent.layout.width); }} data={timeline} keyExtractor={(item) => item.id} renderItem={({ item, index }) => { const chronologicalIndex = reverseListIndex(index, messages.length); const sequence = turnSequenceForMessage(item); const older = timeline[index + 1]; const olderSequence = older ? turnSequenceForMessage(older) : null; const showTurnMarker = sequence !== null && sequence !== olderSequence; const turn = sequence === null ? null : view.turnIndex.find((entry) => entry.sequence === sequence); const messageTurn = typeof item.meta?.turnId === "string" ? view.turns.find((entry) => entry.id === item.meta?.turnId) : null; return <View onLayout={(event) => { if (chatScrollTrace.isRecording()) trace("row.layout", { message: chatScrollTrace.alias("message", item.id), index, sequence, ...event.nativeEvent.layout }); if (chronologicalIndex >= 0) measurements.measure(measuredMessages[chronologicalIndex]!, event.nativeEvent.layout.height); }}>{showTurnMarker ? <TurnMarker sequence={sequence} status={turn?.status} /> : null}<MessageBubble message={item} local={item.meta?.optimistic === true} onCopy={handleCopyMessage} onFork={messageTurn && isTerminalTurnStatus(messageTurn.status) ? forkMessage : undefined} forkDisabled={forkingTurnId !== null} forking={forkingTurnId === turn?.id} spaceId={spaceId || null} />{item.role === "user" && view.turns.filter((entry) => entry.sequence === sequence).map((entry) => entry.id === view.stream?.turnId ? <StreamingTurnProcess key={entry.id} messages={view.stream.intermediateMessages} /> : <TurnProcess key={entry.id} turn={entry} client={client} spaceId={spaceId} />)}</View>; }} keyboardShouldPersistTaps="handled" maintainVisibleContentPosition={followingTail ? undefined : { minIndexForVisible: 0, autoscrollToTopThreshold: 80 }} viewabilityConfig={messageViewabilityConfig} onViewableItemsChanged={onViewableItemsChanged} scrollEventThrottle={100} onScroll={handleScroll} onScrollBeginDrag={handleScrollBeginDrag} onScrollEndDrag={handleScrollEndDrag} onMomentumScrollBegin={handleMomentumScrollBegin} onMomentumScrollEnd={handleMomentumScrollEnd} contentContainerStyle={{ paddingTop: 12, paddingBottom: 12, flexGrow: timeline.length === 0 ? 1 : undefined }} onContentSizeChange={handleContentSizeChange} onScrollToIndexFailed={handleScrollToIndexFailed} onRefresh={() => void refreshSession(sessionId)} refreshing={view.refreshing} ListHeaderComponent={<View>{view.hasMoreNewer ? <Pressable accessibilityRole="button" accessibilityLabel={t("chat.loadNewer")} disabled={view.loadingNewer} onPress={() => void loadNewerTurns(sessionId)} style={({ pressed }) => ({ minHeight: 42, marginHorizontal: 16, marginBottom: 8, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}>{view.loadingNewer ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>{t("chat.loadNewer")}</Text>}</Pressable> : null}{liveStream && view.stream ? <><StreamingTurnProcess messages={view.turns.some((turn) => turn.id === view.stream?.turnId) ? [] : view.stream.intermediateMessages} /><StreamCard content={view.stream.contentBlocks} status={view.stream.status} runtimePhase={view.stream.runtimePhase} runtimeModel={view.stream.runtimeModel} /></> : view.sending && !liveStream ? <StreamCard content={[]} status="pending" /> : null}</View>} ListFooterComponent={view.hasMoreOlder ? <Pressable accessibilityRole="button" accessibilityLabel={t("chat.loadOlder")} disabled={view.loadingOlder} onPress={() => void loadOlderTurns(sessionId)} style={({ pressed }) => ({ minHeight: 42, marginHorizontal: 16, marginTop: 8, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}>{view.loadingOlder ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>{t("chat.loadOlder")}</Text>}</Pressable> : null} />
        {threadPlaceholder ? <View pointerEvents="none" style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}><ChatThreadPlaceholder kind={threadPlaceholder} /></View> : null}
        {!followingTail ? <Pressable accessibilityRole="button" accessibilityLabel={t("chat.jumpLatest")} onPress={() => { cancelTurnScroll(); setFollowingTail(true); requestFollowTail(true); }} style={({ pressed }) => ({ position: "absolute", right: 16, bottom: 12, zIndex: 4, width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised, borderWidth: 1, borderColor: theme.colors.border, shadowColor: theme.colors.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.22, shadowRadius: 5, elevation: 4 })}><AppIcon name="arrow-down" size={18} color={theme.colors.accent} /></Pressable> : null}
        </View>
        {queuedFollowups.length > 0 ? <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, backgroundColor: theme.colors.background, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6, gap: 6 }}>
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
        <ComposerInput anchorRef={composerRef} attachmentMenuOpen={attachmentMenuOpen} modelMenuOpen={modelSelectorOpen} value={input} onChangeText={setInput} onSend={() => void submit()} onStop={() => void stopGeneration()} onAttach={() => { setModelSelectorOpen(false); setAttachmentMenuOpen(true); }} sending={view.sending} onVoice={() => voice.isRecording ? voice.stop() : void voice.start()} onModelPress={() => { setAttachmentMenuOpen(false); void Promise.all([loadModels(), loadModelStatus()]).catch(() => undefined); setModelSelectorOpen(true); }} modelLabel={modelTriggerLabel} modelStatus={activeStatus} voiceActive={voice.isRecording} voiceStarting={voice.isStarting} disabled={view.loading || stopping} running={running} hasAttachment={attachments.length > 0} placeholder={running ? t("ui.composer.working") : t("ui.composer.placeholder")} />
        <AdaptiveSheet visible={moreOpen} title={t("chat.actions.title")} onClose={() => setMoreOpen(false)} scrollable={false} testID="chat-actions-sheet">
          {tracing ? <SheetAction icon="activity" title="Scroll Diagnostics" onPress={() => { trace("experiment.mark", { origin: "chatMenu" }); setMoreOpen(false); router.push("/debug/chat-scroll"); }} /> : null}
          <SheetAction icon="share" title={t("chat.actions.share")} detail={t("chat.actions.shareDetail")} onPress={() => void shareChat()} />
          <SheetAction icon="messages" title={t("chat.actions.openChats")} detail={t("chat.actions.openChatsDetail")} disabled={!spaceId} onPress={() => { setMoreOpen(false); setActivePanel("chat"); }} />
          <SheetAction icon="folder-open" title={t("chat.actions.openFiles")} detail={t("chat.actions.openFilesDetail")} disabled={!spaceId} onPress={() => { setMoreOpen(false); setActivePanel("files"); }} />
          <SheetAction icon="tag" title={t("chat.actions.labels")} detail={t("chat.actions.labelsDetail")} disabled={!client || !spaceId} onPress={openLabelSheet} />
          <SheetAction icon="square-pen" title={t("chat.actions.rename")} detail={t("chat.actions.renameDetail")} onPress={openRename} />
        </AdaptiveSheet>
        {labelSheetOpen && client && session && spaceId ? <SessionLabelSheet client={client} spaceId={spaceId} session={session} labels={chatLabels} labelsError={null} onLabelsReload={() => { if (client && spaceId) void fetchSessionLabels(client, spaceId).then((tree) => setChatLabels(toUserSessionLabels(tree))).catch(() => undefined); }} onClose={() => setLabelSheetOpen(false)} onChanged={() => undefined} /> : null}
        {attachmentMenuOpen ? <AttachmentMenu anchorRef={composerRef} onClose={() => setAttachmentMenuOpen(false)} onCamera={() => void takePhoto()} onPhotos={() => void pickPhotos()} onFile={() => void pickAttachments()} /> : null}
        <TurnNavigatorSheet visible={turnNavigatorOpen} turns={view.turnIndex} currentSequence={currentTurnSequence} loading={view.turnIndexLoading} loadingSequence={loadingSequence} onClose={() => setTurnNavigatorOpen(false)} onJump={(sequence) => handleTurnJump(sequence)} onRetry={() => void loadTurnIndex(sessionId, { force: true }).catch(() => undefined)} />
        {modelSelectorOpen ? <ModelSelectorMenu anchorRef={composerRef} models={models} loading={modelsLoading} error={modelsError || modelStatusError} modelStatus={modelStatus?.models ?? null} modelStatusLoading={modelStatusLoading} currentModel={modelOverride ? selectedModel : recordedModel} onClose={() => setModelSelectorOpen(false)} onRetry={() => void Promise.all([loadModels({ force: true }), loadModelStatus({ force: true })]).catch(() => undefined)} onSelect={(model) => { setSelectedModel(model); setModelOverride(true); setModelSelectorOpen(false); }} /> : null}
        <AdaptiveSheet visible={notice !== null} title={notice?.title ?? t("common.notice")} onClose={() => setNotice(null)} scrollable={false} footer={<View style={{ alignItems: "flex-end" }}><PrimaryButton label={t("common.done")} onPress={() => setNotice(null)} style={{ minHeight: 44, paddingHorizontal: 18 }} /></View>} testID="chat-notice-sheet"><Text style={[typography.body, { color: theme.colors.textSecondary }]}>{notice?.message ?? ""}</Text></AdaptiveSheet>
        <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}><View style={{ flex: 1, justifyContent: "center", padding: 22, backgroundColor: "rgba(0,0,0,0.6)" }}><View style={{ borderRadius: 18, padding: 18, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }}><Text style={[typography.heading, { color: theme.colors.text }]}>{t("chat.rename.title")}</Text><TextInput autoFocus value={renameValue} onChangeText={setRenameValue} maxLength={80} placeholder={t("chat.rename.placeholder")} placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 48, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, paddingHorizontal: 12, marginTop: 14 }]} /><View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 }}><Pressable onPress={() => setRenameOpen(false)} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center" }}><Text style={[typography.bodyMedium, { color: theme.colors.textMuted }]}>{t("common.cancel")}</Text></Pressable><PrimaryButton label={t("common.save")} onPress={() => void saveRename()} style={{ minHeight: 44, paddingHorizontal: 16 }} /></View></View></View></Modal>
      </View>
    </SpacePanels>
  </Screen>;
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
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 13, paddingBottom: 2 }}><View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} /><Text style={[typography.micro, { color }]}>#{sequence}</Text><View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} /></View>;
}

function DraftChatContent({ spaceId }: { spaceId: string }) {
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const showToast = useToast();
  const { state, client, connectionState, sendNewMessage, getAccessToken, loadModels, loadModelStatus, models, modelsLoading, modelsError, modelStatus, modelStatusLoading, modelStatusError } = useApp();
  const space = state.spaces.find((item) => item.id === spaceId) ?? null;
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
  if (!space) return <Screen><DetailTopBar title={t("chat.spaceUnavailable")} onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center" }]}>{t("chat.spaceUnavailable.body")}</Text></View></Screen>;
  const spaceName = displaySpaceName(space);
  const spaceSessions = state.sessions.filter((item) => item.spaceId === space.id);
  const modelLabel = selectedModel?.name || selectedModel?.id || t("chat.model.automatic");
  const modelTriggerLabel = selectedModel?.thinkingLevel ? `${modelLabel} · ${formatThinkingLevel(selectedModel.thinkingLevel)}` : modelLabel;
  const selectedStatus = selectedModel ? modelAvailabilityLevel(modelStatus?.models[selectedModel.id]) : "unknown";
  return <Screen keyboard>
    <SpacePanels key={space.id} spaceId={space.id} spaceName={spaceName} sessions={spaceSessions} client={client} activePanel={activePanel} onActivePanelChange={setActivePanel} onOpenSession={(nextSessionId, target) => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: nextSessionId, ...(target?.turn != null ? { turn: String(target.turn) } : {}), ...(target?.turnId ? { turnId: target.turnId } : {}) } })} onNewChat={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId: space.id } })} onOpenFile={(path) => router.push({ pathname: "/space/[spaceId]/file", params: { spaceId: space.id, path } })} onOpenFilesPage={() => router.push({ pathname: "/space/[spaceId]/files", params: { spaceId: space.id } })}>
      <View style={{ flex: 1, minHeight: 0 }}>
        <DetailTopBar title={spaceName} subtitle={t("chat.draft.subtitle")} onBack={() => router.back()} actions={<><IconButton name="messages" label={t("chat.actions.openChats")} size={38} onPress={() => setActivePanel("chat")} /><IconButton name="folder-open" label={t("chat.actions.openFiles")} size={38} onPress={() => setActivePanel("files")} /></>} />
        <ConnectionBanner state={connectionState} />
        <View style={{ flex: 1, minHeight: 0 }}>
          <View style={{ flex: 1, minHeight: 0, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingBottom: 18 }}><View style={{ width: 58, height: 58, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.accentBorder }}><AppIcon name="sparkles" size={26} color={theme.colors.accent} /></View><Text style={[typography.title, { color: theme.colors.text, marginTop: 15, textAlign: "center" }]}>{t("chat.draft.title")}</Text><Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 7, textAlign: "center", maxWidth: 320 }]}>{t("chat.draft.body")}</Text></View>
          {attachments.length > 0 ? <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 7, backgroundColor: theme.colors.background }}>{attachments.map((attachment, index) => <AttachmentChip key={`${attachment.uri}-${index}`} name={attachment.name} onRemove={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</View> : null}
          {voice.partial || voice.error ? <View style={{ paddingHorizontal: 16, paddingTop: 5, backgroundColor: theme.colors.background }}><Text style={[typography.caption, { color: voice.error ? theme.colors.danger : theme.colors.textMuted }]}>{voice.error ? voice.error : t("chat.listening", { text: voice.partial })}</Text></View> : null}
          <ComposerInput anchorRef={composerRef} attachmentMenuOpen={attachmentMenuOpen} modelMenuOpen={modelSelectorOpen} value={input} onChangeText={setInput} onSend={() => void submit()} onAttach={() => { setModelSelectorOpen(false); setAttachmentMenuOpen(true); }} sending={sending} onVoice={() => voice.isRecording ? voice.stop() : void voice.start()} onModelPress={() => { setAttachmentMenuOpen(false); void Promise.all([loadModels(), loadModelStatus()]).catch(() => undefined); setModelSelectorOpen(true); }} modelLabel={modelTriggerLabel} modelStatus={selectedStatus} voiceActive={voice.isRecording} voiceStarting={voice.isStarting} disabled={sending} hasAttachment={attachments.length > 0} placeholder={sending ? t("chat.draft.starting") : t("ui.composer.placeholder")} />
        </View>
        {modelSelectorOpen ? <ModelSelectorMenu anchorRef={composerRef} models={models} loading={modelsLoading} error={modelsError || modelStatusError} modelStatus={modelStatus?.models ?? null} modelStatusLoading={modelStatusLoading} currentModel={selectedModel} onClose={() => setModelSelectorOpen(false)} onRetry={() => void Promise.all([loadModels({ force: true }), loadModelStatus({ force: true })]).catch(() => undefined)} onSelect={(model) => { setSelectedModel(model); setModelSelectorOpen(false); }} /> : null}
        {attachmentMenuOpen ? <AttachmentMenu anchorRef={composerRef} onClose={() => setAttachmentMenuOpen(false)} onCamera={() => void takePhoto()} onPhotos={() => void pickPhotos()} onFile={() => void pickAttachments()} /> : null}
        <AdaptiveSheet visible={notice !== null} title={notice?.title ?? t("common.notice")} onClose={() => setNotice(null)} scrollable={false} footer={<View style={{ alignItems: "flex-end" }}><PrimaryButton label={t("common.done")} onPress={() => setNotice(null)} style={{ minHeight: 44, paddingHorizontal: 18 }} /></View>} testID="new-chat-notice-sheet"><Text style={[typography.body, { color: theme.colors.textSecondary }]}>{notice?.message ?? ""}</Text></AdaptiveSheet>
      </View>
    </SpacePanels>
  </Screen>;
}

function MissingChat() {
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  return <Screen><DetailTopBar title={t("chat.title")} onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>{t("chat.missing")}</Text></View></Screen>;
}
