import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, Text, TextInput, View, useWindowDimensions, type ViewToken } from "react-native";
import { AdaptiveSheet, SheetAction } from "@/src/components/AdaptiveSheet";
import { ContextMenu } from "@/src/components/ContextMenu";
import { copyMessageText, MessageBubble, shareMessageText, StreamCard } from "@/src/components/MessageContent";
import { StreamingTurnProcess, TurnProcess } from "@/src/components/TurnProcess";
import { ModelSelectorSheet } from "@/src/components/ModelSelectorSheet";
import { SessionLabelSheet } from "@/src/components/SessionLabelSheet";
import { fetchSessionLabels, toUserSessionLabels, type SessionLabel } from "@/src/data/session-labels";
import { TurnNavigatorSheet } from "@/src/components/TurnNavigatorSheet";
import { SpacePanels, type SpacePanel } from "@/src/components/SpacePanels";
import { useApp, useSession } from "@/src/data/context";
import { CHAT_PAGE_THRESHOLD, invertedListDistances, nextChatTailFollowing, reverseListIndex } from "@/src/data/chat-scroll";
import { cancelQueuedFollowup, followupPreviewText, queuedFollowupTurns, steerQueuedFollowup } from "@/src/data/followup-queue";
import { isLiveStreamStatus, shouldShowLiveStream } from "@/src/data/chat-stream";
import { MessageMeasurements } from "@/src/data/chat-rendering";
import type { AttachmentDraft, ChatModelSelection } from "@/src/data/types";
import type { MessageRecord } from "@neta-art/cohub";
import { mergeDisplayMessages, messageIndexForTurn, messagesFromTurns, turnSequenceForMessage, withTurnSequences } from "@/src/data/session-history";
import { useAppTheme, typography } from "@/src/theme";
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
  const { state, client, offline, connectionState, sendMessage, abortSession, refreshSession, loadOlderTurns, loadNewerTurns, loadTurnIndex, jumpToTurn, renameSession, getAccessToken, loadModels, loadModelStatus, models, modelsLoading, modelsError, modelStatus, modelStatusLoading, modelStatusError, loadSessionReadSequence, saveSessionReadSequence } = useApp();
  const view = useSession(sessionId);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
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
  const [messageAction, setMessageAction] = useState<{ text: string; x: number; y: number } | null>(null);
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
  const setFollowingTail = useCallback((next: boolean) => {
    if (followingTailRef.current === next) return;
    followingTailRef.current = next;
    setFollowingTailState(next);
  }, []);
  const cancelTurnScroll = useCallback(() => {
    pendingScrollSequence.current = null;
    turnScrollTargetRef.current = null;
    turnScrollRetriesRef.current.clear();
    if (turnScrollRetryTimerRef.current !== null) {
      clearTimeout(turnScrollRetryTimerRef.current);
      turnScrollRetryTimerRef.current = null;
    }
  }, []);
  const requestFollowTail = useCallback((animated = false) => {
    if (!followingTailRef.current || userDraggingRef.current || momentumScrollingRef.current || pendingScrollSequence.current !== null || turnScrollTargetRef.current !== null) return;
    if (followTailFrameRef.current !== null) cancelAnimationFrame(followTailFrameRef.current);
    followTailFrameRef.current = requestAnimationFrame(() => {
      followTailFrameRef.current = null;
      if (!followingTailRef.current || userDraggingRef.current || momentumScrollingRef.current || pendingScrollSequence.current !== null || turnScrollTargetRef.current !== null) return;
      listRef.current?.scrollToOffset({ offset: 0, animated });
      requestAnimationFrame(() => {
        if (!followingTailRef.current || userDraggingRef.current || momentumScrollingRef.current) return;
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
      });
    });
  }, []);
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
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
  }, [saveSessionReadSequence, sessionId]);
  const session = view.session ?? state.sessions.find((item) => item.id === sessionId) ?? null;
  const sessionSummary = state.sessions.find((item) => item.id === sessionId) ?? null;
  const spaceId = view.space?.id ?? session?.spaceId ?? sessionSummary?.spaceId ?? "";
  const spaceName = view.space ? displaySpaceName(view.space) : sessionSummary?.space?.name || "Space";
  const spaceSessions = useMemo(() => state.sessions.filter((item) => item.spaceId === spaceId), [spaceId, state.sessions]);
  const queuedFollowups = useMemo(() => queuedFollowupTurns(view.turns, view.stream?.turnId), [view.stream?.turnId, view.turns]);
  const queuedFollowupIds = useMemo(() => new Set(queuedFollowups.map((turn) => turn.id)), [queuedFollowups]);
  const messages = useMemo(() => {
    const history = messagesFromTurns(view.turns);
    return withTurnSequences(
      mergeDisplayMessages(history.length > 0 ? history : view.messages, history.length > 0 ? view.messages : [])
        .filter((message) => !isAssistantIntermediate(message) && hasRenderableMessage(message) && !(typeof message.meta?.turnId === "string" && queuedFollowupIds.has(message.meta.turnId)))
        .sort((a, b) => a.sequence - b.sequence),
      view.turns,
    );
  }, [queuedFollowupIds, view.messages, view.turns]);
  const timeline = useMemo(() => messages.slice().reverse(), [messages]);
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
  const modelLabel = activeModel?.name || activeModel?.id || "Automatic";
  const modelTriggerLabel = activeModel?.thinkingLevel ? `${modelLabel} · ${formatThinkingLevel(activeModel.thinkingLevel)}` : modelLabel;
  const liveStream = shouldShowLiveStream(view.stream, messages);
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
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setFollowingTail(true);
    setCurrentTurnSequence(view.turns.at(-1)?.sequence ?? null);
  }, [hasInitialTurnTarget, messages.length, setFollowingTail, view.historyLoaded, view.turns]);

  const scheduleTurnScrollRetry = useCallback((sequence: number, retry: number) => {
    if (retry >= 4) {
      if (turnScrollTargetRef.current === sequence) turnScrollTargetRef.current = null;
      turnScrollRetriesRef.current.delete(sequence);
      return;
    }
    if (turnScrollRetryTimerRef.current !== null) clearTimeout(turnScrollRetryTimerRef.current);
    turnScrollRetryTimerRef.current = setTimeout(() => {
      turnScrollRetryTimerRef.current = null;
      if (turnScrollTargetRef.current !== sequence) return;
      const index = targetMessageIndex(sequence);
      if (index < 0 || !listRef.current) return;
      turnScrollRetriesRef.current.set(sequence, retry + 1);
      listRef.current.scrollToIndex({ index: reverseListIndex(index, messages.length), animated: false, viewPosition: 0.15, viewOffset: 8 });
    }, retry === 0 ? 120 : 180);
  }, [messages.length, targetMessageIndex]);
  const scrollToTurn = useCallback((sequence: number, retry = 0) => {
    const index = targetMessageIndex(sequence);
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
    listRef.current.scrollToIndex({ index: reverseListIndex(index, messages.length), animated: retry === 0, viewPosition: 0.15, viewOffset: 8 });
    scheduleTurnScrollRetry(sequence, retry);
    setCurrentTurnSequence(sequence);
  }, [messages.length, scheduleTurnScrollRetry, setFollowingTail, targetMessageIndex]);

  const handleTurnJump = async (sequence: number) => {
    setLoadingSequence(sequence);
    try {
      const resolvedSequence = await jumpToTurn(sessionId, sequence);
      scrollToTurn(resolvedSequence);
      setTurnNavigatorOpen(false);
    } catch (error) {
      setNotice({ title: "Turn unavailable", message: error instanceof Error ? error.message : "Unable to open this part of the Chat." });
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

  useEffect(() => {
    if (!view.stream || !followingTailRef.current || pendingScrollSequence.current !== null || turnScrollTargetRef.current !== null) return;
    requestFollowTail();
  }, [requestFollowTail, view.stream]);

  useEffect(() => () => {
    if (followTailFrameRef.current !== null) cancelAnimationFrame(followTailFrameRef.current);
    if (turnScrollRetryTimerRef.current !== null) clearTimeout(turnScrollRetryTimerRef.current);
  }, []);

  useEffect(() => {
    const targetKey = initialTurnId ? `id:${initialTurnId}` : initialTurnSequence !== null ? `sequence:${initialTurnSequence}` : null;
    if (!targetKey || (!client && !offline) || !spaceId || !view.historyLoaded || handledDeepLinkTarget.current === targetKey) return;
    handledDeepLinkTarget.current = targetKey;
    const target = initialTurnId ? { turnId: initialTurnId } : initialTurnSequence;
    if (target === null) return;
    const localTarget = view.turns.find((turn) => typeof target === "number"
      ? turn.sequence === target
      : turn.id === target.turnId || turn.sourceTurnId === target.turnId);
    void (async () => {
      try {
        const sequence = offline && localTarget ? localTarget.sequence : await jumpToTurn(sessionId, target);
        pendingScrollSequence.current = sequence;
        scrollToTurn(sequence);
      } catch (error) {
        setNotice({ title: "Turn unavailable", message: error instanceof Error ? error.message : "Unable to open the requested part of the Chat." });
      }
    })();
  }, [client, initialTurnId, initialTurnSequence, jumpToTurn, offline, scrollToTurn, sessionId, spaceId, view.historyLoaded, view.turns]);

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
    } catch (error) { setNotice({ title: "Attachment unavailable", message: error instanceof Error ? error.message : "Unable to select a file." }); }
  };
  const pickPhotos = async () => {
    setAttachmentMenuOpen(false);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) { setNotice({ title: "Photo access is off", message: "Allow photo access in system settings to attach an image." }); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 0.88 });
      if (result.canceled) return;
      appendAttachments(result.assets.map((asset, index) => ({ uri: asset.uri, name: asset.fileName || `image-${index + 1}.jpg`, mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 })));
    } catch (error) { setNotice({ title: "Photo picker unavailable", message: error instanceof Error ? error.message : "Unable to select a photo." }); }
  };
  const takePhoto = async () => {
    setAttachmentMenuOpen(false);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) { setNotice({ title: "Camera access is off", message: "Allow camera access in system settings to take a photo." }); return; }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.88 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset) appendAttachments([{ uri: asset.uri, name: asset.fileName || "camera-photo.jpg", mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 }]);
    } catch (error) { setNotice({ title: "Camera unavailable", message: error instanceof Error ? error.message : "Unable to take a photo." }); }
  };
  const stopGeneration = async () => {
    if (stopping) return;
    setStopping(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try { await abortSession(sessionId); } catch (error) { setNotice({ title: "Unable to stop", message: error instanceof Error ? error.message : "The Agent could not be stopped." }); } finally { setStopping(false); }
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
      setNotice({ title: action === "steer" ? "Unable to steer" : "Unable to cancel", message: error instanceof Error ? error.message : "Please try again." });
      void refreshSession(sessionId).catch(() => undefined);
    } finally {
      setPendingFollowupAction(null);
    }
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
    try { await renameSession(sessionId, renameValue); setRenameOpen(false); } catch (error) { setNotice({ title: "Rename failed", message: error instanceof Error ? error.message : "Unable to rename this Chat." }); }
  };
  const handleScroll = useCallback((event: ChatScrollEvent) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const { distanceToLatest, distanceToOldest } = invertedListDistances(contentOffset.y, contentSize.height, layoutMeasurement.height);
    setFollowingTail(nextChatTailFollowing({
      currentlyFollowing: followingTailRef.current,
      distanceToBottom: distanceToLatest,
      userInteracting: userDraggingRef.current || momentumScrollingRef.current,
      pendingTarget: pendingScrollSequence.current !== null || (turnScrollTargetRef.current !== null && !targetIsLatestMessage()),
    }));
    if (initialScrollDone.current && distanceToOldest < CHAT_PAGE_THRESHOLD && view.hasMoreOlder && !view.loadingOlder) void loadOlderTurns(sessionId);
    if (distanceToLatest < CHAT_PAGE_THRESHOLD && view.hasMoreNewer && !view.loadingNewer) void loadNewerTurns(sessionId);
  }, [loadNewerTurns, loadOlderTurns, sessionId, setFollowingTail, targetIsLatestMessage, view.hasMoreNewer, view.hasMoreOlder, view.loadingNewer, view.loadingOlder]);

  const handleContentSizeChange = useCallback(() => {
    const pending = pendingScrollSequence.current;
    if (pending !== null) {
      scrollToTurn(pending);
      if (pendingScrollSequence.current !== null) return;
      initialScrollDone.current = true;
      return;
    }
    requestInitialScroll();
    requestFollowTail();
  }, [requestFollowTail, requestInitialScroll, scrollToTurn]);

  const handleScrollToIndexFailed = useCallback(({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
    const initialUnreadIndex = initialUnreadIndexRef.current;
    if (initialUnreadIndex !== null) {
      const retries = initialUnreadRetriesRef.current;
      if (retries >= 4) {
        initialUnreadIndexRef.current = null;
        return;
      }
      initialUnreadRetriesRef.current = retries + 1;
      listRef.current?.scrollToOffset({ offset: estimatedOffset(index, averageItemLength), animated: false });
      requestAnimationFrame(() => {
        if (initialUnreadIndexRef.current === initialUnreadIndex) listRef.current?.scrollToIndex({ index: initialUnreadIndex, animated: false, viewPosition: 0.15, viewOffset: 8 });
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
    listRef.current?.scrollToOffset({ offset: estimatedOffset(index, averageItemLength), animated: false });
    requestAnimationFrame(() => {
      if (turnScrollTargetRef.current === target) scrollToTurn(target, retries + 1);
    });
  }, [estimatedOffset, scrollToTurn]);

  const handleScrollBeginDrag = useCallback(() => {
    userDraggingRef.current = true;
    momentumScrollingRef.current = false;
    if (followTailFrameRef.current !== null) {
      cancelAnimationFrame(followTailFrameRef.current);
      followTailFrameRef.current = null;
    }
    cancelTurnScroll();
  }, [cancelTurnScroll]);

  const handleScrollEndDrag = useCallback((event: ChatScrollEvent) => {
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
  }, [requestFollowTail, setFollowingTail]);

  const handleMomentumScrollBegin = useCallback(() => {
    if (userDraggingRef.current) momentumScrollingRef.current = true;
  }, []);

  const handleMomentumScrollEnd = useCallback((event: ChatScrollEvent) => {
    userDraggingRef.current = false;
    momentumScrollingRef.current = false;
    if (pendingScrollSequence.current !== null) return;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const { distanceToLatest } = invertedListDistances(contentOffset.y, contentSize.height, layoutMeasurement.height);
    setFollowingTail(nextChatTailFollowing({ currentlyFollowing: followingTailRef.current, distanceToBottom: distanceToLatest, userInteracting: false, pendingTarget: pendingScrollSequence.current !== null || (turnScrollTargetRef.current !== null && !targetIsLatestMessage()) }));
    requestFollowTail();
  }, [requestFollowTail, setFollowingTail, targetIsLatestMessage]);

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

  if (view.loading && !session && view.messages.length === 0 && view.turns.length === 0) return <Screen><DetailTopBar title="Chat" onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>Opening Chat…</Text></View></Screen>;
  return <Screen keyboard>
    <SpacePanels key={spaceId || sessionId} spaceId={spaceId} spaceName={spaceName} sessions={spaceSessions} client={client} activePanel={activePanel} onActivePanelChange={setActivePanel} onOpenSession={(nextSessionId, target) => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: nextSessionId, ...(target?.turn != null ? { turn: String(target.turn) } : {}), ...(target?.turnId ? { turnId: target.turnId } : {}) } })} onNewChat={() => { if (spaceId) router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId } }); }} onOpenFile={(path) => { if (spaceId) router.push({ pathname: "/space/[spaceId]/file", params: { spaceId, path } }); }} onOpenFilesPage={() => { if (spaceId) router.push({ pathname: "/space/[spaceId]/files", params: { spaceId } }); }}>
      <View style={{ flex: 1 }}>
        <DetailTopBar title={session ? displaySessionTitle(session) : "Chat"} subtitle={spaceName} onBack={() => router.back()} actions={<><IconButton name="list-tree" label="Open conversation turns" size={38} onPress={() => setTurnNavigatorOpen(true)} disabled={view.turnIndex.length === 0 && view.loading} /><IconButton name="messages" label="Open Chats" size={38} onPress={() => setActivePanel("chat")} disabled={!spaceId} /><IconButton name="folder-open" label="Open Files" size={38} onPress={() => setActivePanel("files")} disabled={!spaceId} /><IconButton name="tag" label="Manage labels" size={38} onPress={openLabelSheet} disabled={!client || !spaceId} /><IconButton name="more" label="More actions" size={38} onPress={openRename} /></>} />
        <ConnectionBanner state={connectionState} />
        {view.error ? <Pressable onPress={() => void refreshSession(sessionId)} style={({ pressed }) => ({ marginHorizontal: 16, marginTop: 12, padding: 11, borderRadius: 12, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.dangerSoft, flexDirection: "row", alignItems: "center", gap: 8 })}><AppIcon name="alert" size={16} color={theme.colors.danger} /><Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{view.error}</Text><Text style={[typography.caption, { color: theme.colors.danger }]}>Retry</Text></Pressable> : null}
        <View style={{ flex: 1 }}>
        <FlatList ref={listRef} inverted initialNumToRender={16} maxToRenderPerBatch={8} updateCellsBatchingPeriod={32} windowSize={11} onLayout={(event) => setListWidth(event.nativeEvent.layout.width)} data={timeline} keyExtractor={(item) => item.id} renderItem={({ item, index }) => { const chronologicalIndex = reverseListIndex(index, messages.length); const sequence = turnSequenceForMessage(item); const older = timeline[index + 1]; const olderSequence = older ? turnSequenceForMessage(older) : null; const showTurnMarker = sequence !== null && sequence !== olderSequence; const turn = sequence === null ? null : view.turnIndex.find((entry) => entry.sequence === sequence); return <View onLayout={(event) => { if (chronologicalIndex >= 0) measurements.measure(measuredMessages[chronologicalIndex]!, event.nativeEvent.layout.height); }}>{showTurnMarker ? <TurnMarker sequence={sequence} status={turn?.status} /> : null}<MessageBubble message={item} local={item.meta?.optimistic === true} onLongPress={(text, origin) => setMessageAction({ text, ...origin })} />{item.role === "user" && view.turns.filter((entry) => entry.sequence === sequence).map((entry) => entry.id === view.stream?.turnId ? <StreamingTurnProcess key={entry.id} messages={view.stream.intermediateMessages} /> : <TurnProcess key={entry.id} turn={entry} client={client} spaceId={spaceId} />)}</View>; }} keyboardShouldPersistTaps="handled" maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }} viewabilityConfig={messageViewabilityConfig} onViewableItemsChanged={onViewableItemsChanged} scrollEventThrottle={100} onScroll={handleScroll} onScrollBeginDrag={handleScrollBeginDrag} onScrollEndDrag={handleScrollEndDrag} onMomentumScrollBegin={handleMomentumScrollBegin} onMomentumScrollEnd={handleMomentumScrollEnd} contentContainerStyle={{ paddingTop: 12, paddingBottom: 12, flexGrow: timeline.length === 0 ? 1 : undefined }} onContentSizeChange={handleContentSizeChange} onScrollToIndexFailed={handleScrollToIndexFailed} onRefresh={() => void refreshSession(sessionId)} refreshing={view.refreshing} ListHeaderComponent={<View>{view.hasMoreNewer ? <Pressable accessibilityRole="button" accessibilityLabel="Load newer turns" disabled={view.loadingNewer} onPress={() => void loadNewerTurns(sessionId)} style={({ pressed }) => ({ minHeight: 42, marginHorizontal: 16, marginBottom: 8, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}>{view.loadingNewer ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>Load newer turns</Text>}</Pressable> : null}{liveStream && view.stream ? <><StreamingTurnProcess messages={view.turns.some((turn) => turn.id === view.stream?.turnId) ? [] : view.stream.intermediateMessages} /><StreamCard content={view.stream.contentBlocks} status={view.stream.status} runtimePhase={view.stream.runtimePhase} runtimeModel={view.stream.runtimeModel} onLongPress={(text, origin) => setMessageAction({ text, ...origin })} /></> : view.sending && !liveStream ? <StreamCard content={[]} status="pending" onLongPress={(text, origin) => setMessageAction({ text, ...origin })} /> : null}</View>} ListEmptyComponent={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 28, transform: [{ scaleY: -1 }] }}><View style={{ width: 52, height: 52, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accentSoft }}><AppIcon name="sparkles" size={23} color={theme.colors.accent} /></View><Text style={[typography.heading, { color: theme.colors.text, marginTop: 14 }]}>A fresh Space for thinking</Text><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center", marginTop: 6, maxWidth: 290 }]}>Send a prompt to start working with the Agent.</Text></View>} ListFooterComponent={view.hasMoreOlder ? <Pressable accessibilityRole="button" accessibilityLabel="Load earlier turns" disabled={view.loadingOlder} onPress={() => void loadOlderTurns(sessionId)} style={({ pressed }) => ({ minHeight: 42, marginHorizontal: 16, marginTop: 8, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}>{view.loadingOlder ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>Load earlier turns</Text>}</Pressable> : null} />
        {!followingTail ? <Pressable accessibilityRole="button" accessibilityLabel="Jump to latest" onPress={() => { cancelTurnScroll(); setFollowingTail(true); requestFollowTail(true); }} style={({ pressed }) => ({ position: "absolute", right: 16, bottom: 12, zIndex: 4, width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised, borderWidth: 1, borderColor: theme.colors.border, shadowColor: theme.colors.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.22, shadowRadius: 5, elevation: 4 })}><AppIcon name="arrow-down" size={18} color={theme.colors.accent} /></Pressable> : null}
        </View>
        {queuedFollowups.length > 0 ? <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, backgroundColor: theme.colors.background, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6, gap: 6 }}>
          <Text style={[typography.micro, { color: theme.colors.textMuted }]}>Follow-ups · {queuedFollowups.length} queued</Text>
          {queuedFollowups.map((turn) => {
            const pending = pendingFollowupAction === turn.id;
            const preview = followupPreviewText(turn);
            return <View key={turn.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10, paddingLeft: 10, paddingRight: 6, paddingVertical: 5, backgroundColor: theme.colors.surface }}>
              <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.text, flex: 1 }]}>{preview}</Text>
              {pending ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <>
                <Pressable accessibilityRole="button" accessibilityLabel={`Steer now: ${preview}`} onPress={() => void runFollowupAction(turn.id, "steer")} hitSlop={6} style={({ pressed }) => ({ paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.accentSoft })}><Text style={[typography.caption, { color: theme.colors.accent }]}>Steer now</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`Cancel follow-up: ${preview}`} onPress={() => void runFollowupAction(turn.id, "cancel")} hitSlop={6} style={({ pressed }) => ({ paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}><Text style={[typography.caption, { color: theme.colors.textMuted }]}>Cancel</Text></Pressable>
              </>}
            </View>;
          })}
        </View> : null}
        {attachments.length > 0 ? <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 7, backgroundColor: theme.colors.background }}>{attachments.map((attachment, index) => <AttachmentChip key={`${attachment.uri}-${index}`} name={attachment.name} onRemove={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</View> : null}
        {voice.partial || voice.error ? <View style={{ paddingHorizontal: 16, paddingTop: 5, backgroundColor: theme.colors.background }}><Text style={[typography.caption, { color: voice.error ? theme.colors.danger : theme.colors.textMuted }]}>{voice.error ? voice.error : `Listening · ${voice.partial}`}</Text></View> : null}
        <ComposerInput value={input} onChangeText={setInput} onSend={() => void submit()} onStop={() => void stopGeneration()} onAttach={() => setAttachmentMenuOpen(true)} sending={view.sending} onVoice={() => voice.isRecording ? voice.stop() : void voice.start()} onModelPress={() => { void Promise.all([loadModels(), loadModelStatus()]).catch(() => undefined); setModelSelectorOpen(true); }} modelLabel={modelTriggerLabel} modelStatus={activeStatus} voiceActive={voice.isRecording} voiceStarting={voice.isStarting} disabled={view.loading || stopping} running={running} hasAttachment={attachments.length > 0} placeholder={running ? "Agent is working…" : "Message the Agent"} />
        {labelSheetOpen && client && session && spaceId ? <SessionLabelSheet client={client} spaceId={spaceId} session={session} labels={chatLabels} labelsError={null} onLabelsReload={() => { if (client && spaceId) void fetchSessionLabels(client, spaceId).then((tree) => setChatLabels(toUserSessionLabels(tree))).catch(() => undefined); }} onClose={() => setLabelSheetOpen(false)} onChanged={() => undefined} /> : null}
        <AdaptiveSheet visible={attachmentMenuOpen} title="Add to Chat" subtitle="Choose what to include with your next message." onClose={() => setAttachmentMenuOpen(false)} scrollable={false} testID="chat-attachment-sheet"><SheetAction icon="images" title="Photo library" detail="Choose one or more images" onPress={() => void pickPhotos()} /><SheetAction icon="camera" title="Take a photo" detail="Use the device camera" onPress={() => void takePhoto()} /><SheetAction icon="paperclip" title="Choose a file" detail="Attach a document or archive" onPress={() => void pickAttachments()} /></AdaptiveSheet>
        <TurnNavigatorSheet visible={turnNavigatorOpen} turns={view.turnIndex} currentSequence={currentTurnSequence} loading={view.turnIndexLoading} loadingSequence={loadingSequence} onClose={() => setTurnNavigatorOpen(false)} onJump={(sequence) => handleTurnJump(sequence)} onRetry={() => void loadTurnIndex(sessionId, { force: true }).catch(() => undefined)} />
        <ModelSelectorSheet key={modelSelectorOpen ? "chat-model-open" : "chat-model-closed"} visible={modelSelectorOpen} models={models} loading={modelsLoading} error={modelsError || modelStatusError} modelStatus={modelStatus?.models ?? null} modelStatusLoading={modelStatusLoading} currentModel={modelOverride ? selectedModel : recordedModel} onClose={() => setModelSelectorOpen(false)} onRetry={() => void Promise.all([loadModels({ force: true }), loadModelStatus({ force: true })]).catch(() => undefined)} onSelect={(model) => { setSelectedModel(model); setModelOverride(true); setModelSelectorOpen(false); }} />
        <ContextMenu visible={messageAction !== null} x={messageAction?.x ?? 0} y={messageAction?.y ?? 0} onClose={() => setMessageAction(null)} testID="chat-message-actions" actions={messageAction ? [{ icon: "copy", title: "Copy", onPress: () => { const value = messageAction.text; if (value) void copyMessageText(value).catch(() => undefined); } }, { icon: "share", title: "Share", onPress: () => { const value = messageAction.text; if (value) void shareMessageText(value).catch(() => undefined); } }] : []} />
        <AdaptiveSheet visible={notice !== null} title={notice?.title ?? "Notice"} onClose={() => setNotice(null)} scrollable={false} footer={<View style={{ alignItems: "flex-end" }}><PrimaryButton label="Done" onPress={() => setNotice(null)} style={{ minHeight: 44, paddingHorizontal: 18 }} /></View>} testID="chat-notice-sheet"><Text style={[typography.body, { color: theme.colors.textSecondary }]}>{notice?.message ?? ""}</Text></AdaptiveSheet>
        <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}><View style={{ flex: 1, justifyContent: "center", padding: 22, backgroundColor: "rgba(0,0,0,0.6)" }}><View style={{ borderRadius: 18, padding: 18, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }}><Text style={[typography.heading, { color: theme.colors.text }]}>Rename Chat</Text><TextInput autoFocus value={renameValue} onChangeText={setRenameValue} maxLength={80} placeholder="Chat name" placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 48, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, paddingHorizontal: 12, marginTop: 14 }]} /><View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 }}><Pressable onPress={() => setRenameOpen(false)} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center" }}><Text style={[typography.bodyMedium, { color: theme.colors.textMuted }]}>Cancel</Text></Pressable><PrimaryButton label="Save" onPress={() => void saveRename()} style={{ minHeight: 44, paddingHorizontal: 16 }} /></View></View></View></Modal>
      </View>
    </SpacePanels>
  </Screen>;
}

function TurnMarker({ sequence, status }: { sequence: number; status?: string }) {
  const theme = useAppTheme();
  const color = status === "failed" ? theme.colors.danger : status === "running" || status === "queued" ? theme.colors.warning : theme.colors.textFaint;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 13, paddingBottom: 2 }}><View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} /><Text style={[typography.micro, { color }]}>#{sequence}</Text><View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} /></View>;
}

function DraftChatContent({ spaceId }: { spaceId: string }) {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, client, connectionState, sendNewMessage, getAccessToken, loadModels, loadModelStatus, models, modelsLoading, modelsError, modelStatus, modelStatusLoading, modelStatusError } = useApp();
  const space = state.spaces.find((item) => item.id === spaceId) ?? null;
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
  const pickAttachments = async () => { setAttachmentMenuOpen(false); try { const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true }); if (result.canceled) return; appendAttachments(result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType || "application/octet-stream", size: asset.size ?? 0 }))); } catch (error) { setNotice({ title: "Attachment unavailable", message: error instanceof Error ? error.message : "Unable to select a file." }); } };
  const pickPhotos = async () => { setAttachmentMenuOpen(false); try { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) { setNotice({ title: "Photo access is off", message: "Allow photo access in system settings to attach an image." }); return; } const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 0.88 }); if (result.canceled) return; appendAttachments(result.assets.map((asset, index) => ({ uri: asset.uri, name: asset.fileName || `image-${index + 1}.jpg`, mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 }))); } catch (error) { setNotice({ title: "Photo picker unavailable", message: error instanceof Error ? error.message : "Unable to select a photo." }); } };
  const takePhoto = async () => { setAttachmentMenuOpen(false); try { const permission = await ImagePicker.requestCameraPermissionsAsync(); if (!permission.granted) { setNotice({ title: "Camera access is off", message: "Allow camera access in system settings to take a photo." }); return; } const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.88 }); if (result.canceled) return; const asset = result.assets[0]; if (asset) appendAttachments([{ uri: asset.uri, name: asset.fileName || "camera-photo.jpg", mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 }]); } catch (error) { setNotice({ title: "Camera unavailable", message: error instanceof Error ? error.message : "Unable to take a photo." }); } };
  const submit = async () => {
    if (!space || sending || (!input.trim() && attachments.length === 0)) return;
    const text = input;
    const files = attachments;
    setInput("");
    setAttachments([]);
    setSending(true);
    try { const session = await sendNewMessage(space.id, text, files, { model: selectedModel }); router.replace({ pathname: "/chat/[sessionId]", params: { sessionId: session.id } }); } catch (error) { setInput(text); setAttachments(files); setNotice({ title: "Chat could not start", message: error instanceof Error ? error.message : "Unable to start this Chat." }); } finally { setSending(false); }
  };
  if (!space) return <Screen><DetailTopBar title="Space unavailable" onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center" }]}>This Space is no longer available.</Text></View></Screen>;
  const spaceName = displaySpaceName(space);
  const spaceSessions = state.sessions.filter((item) => item.spaceId === space.id);
  const modelLabel = selectedModel?.name || selectedModel?.id || "Automatic";
  const modelTriggerLabel = selectedModel?.thinkingLevel ? `${modelLabel} · ${formatThinkingLevel(selectedModel.thinkingLevel)}` : modelLabel;
  const selectedStatus = selectedModel ? modelAvailabilityLevel(modelStatus?.models[selectedModel.id]) : "unknown";
  return <Screen keyboard>
    <SpacePanels key={space.id} spaceId={space.id} spaceName={spaceName} sessions={spaceSessions} client={client} activePanel={activePanel} onActivePanelChange={setActivePanel} onOpenSession={(nextSessionId, target) => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: nextSessionId, ...(target?.turn != null ? { turn: String(target.turn) } : {}), ...(target?.turnId ? { turnId: target.turnId } : {}) } })} onNewChat={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId: space.id } })} onOpenFile={(path) => router.push({ pathname: "/space/[spaceId]/file", params: { spaceId: space.id, path } })} onOpenFilesPage={() => router.push({ pathname: "/space/[spaceId]/files", params: { spaceId: space.id } })}>
      <View style={{ flex: 1 }}>
        <DetailTopBar title={spaceName} subtitle="Start a conversation" onBack={() => router.back()} actions={<><IconButton name="messages" label="Open Chats" size={38} onPress={() => setActivePanel("chat")} /><IconButton name="folder-open" label="Open Files" size={38} onPress={() => setActivePanel("files")} /></>} />
        <ConnectionBanner state={connectionState} />
        <View style={{ flex: 1 }}>
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingBottom: 18 }}><View style={{ width: 58, height: 58, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.accentBorder }}><AppIcon name="sparkles" size={26} color={theme.colors.accent} /></View><Text style={[typography.title, { color: theme.colors.text, marginTop: 15, textAlign: "center" }]}>What are you working on?</Text><Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 7, textAlign: "center", maxWidth: 320 }]}>Your first message will become the conversation title automatically.</Text></View>
          {attachments.length > 0 ? <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 7, backgroundColor: theme.colors.background }}>{attachments.map((attachment, index) => <AttachmentChip key={`${attachment.uri}-${index}`} name={attachment.name} onRemove={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</View> : null}
          {voice.partial || voice.error ? <View style={{ paddingHorizontal: 16, paddingTop: 5, backgroundColor: theme.colors.background }}><Text style={[typography.caption, { color: voice.error ? theme.colors.danger : theme.colors.textMuted }]}>{voice.error ? voice.error : `Listening · ${voice.partial}`}</Text></View> : null}
          <ComposerInput value={input} onChangeText={setInput} onSend={() => void submit()} onAttach={() => setAttachmentMenuOpen(true)} sending={sending} onVoice={() => voice.isRecording ? voice.stop() : void voice.start()} onModelPress={() => { void Promise.all([loadModels(), loadModelStatus()]).catch(() => undefined); setModelSelectorOpen(true); }} modelLabel={modelTriggerLabel} modelStatus={selectedStatus} voiceActive={voice.isRecording} voiceStarting={voice.isStarting} disabled={sending} hasAttachment={attachments.length > 0} placeholder={sending ? "Starting Chat…" : "Message the Agent"} />
        </View>
        <ModelSelectorSheet key={modelSelectorOpen ? "draft-model-open" : "draft-model-closed"} visible={modelSelectorOpen} models={models} loading={modelsLoading} error={modelsError || modelStatusError} modelStatus={modelStatus?.models ?? null} modelStatusLoading={modelStatusLoading} currentModel={selectedModel} onClose={() => setModelSelectorOpen(false)} onRetry={() => void Promise.all([loadModels({ force: true }), loadModelStatus({ force: true })]).catch(() => undefined)} onSelect={(model) => { setSelectedModel(model); setModelSelectorOpen(false); }} />
        <AdaptiveSheet visible={attachmentMenuOpen} title="Add to Chat" subtitle="Choose what to include with your first message." onClose={() => setAttachmentMenuOpen(false)} scrollable={false} testID="new-chat-attachment-sheet"><SheetAction icon="images" title="Photo library" detail="Choose one or more images" onPress={() => void pickPhotos()} /><SheetAction icon="camera" title="Take a photo" detail="Use the device camera" onPress={() => void takePhoto()} /><SheetAction icon="paperclip" title="Choose a file" detail="Attach a document or archive" onPress={() => void pickAttachments()} /></AdaptiveSheet>
        <AdaptiveSheet visible={notice !== null} title={notice?.title ?? "Notice"} onClose={() => setNotice(null)} scrollable={false} footer={<View style={{ alignItems: "flex-end" }}><PrimaryButton label="Done" onPress={() => setNotice(null)} style={{ minHeight: 44, paddingHorizontal: 18 }} /></View>} testID="new-chat-notice-sheet"><Text style={[typography.body, { color: theme.colors.textSecondary }]}>{notice?.message ?? ""}</Text></AdaptiveSheet>
      </View>
    </SpacePanels>
  </Screen>;
}

function MissingChat() {
  const router = useRouter();
  const theme = useAppTheme();
  return <Screen><DetailTopBar title="Chat" onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>This Chat could not be found.</Text></View></Screen>;
}
