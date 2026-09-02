import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, Text, TextInput, View, type ViewToken } from "react-native";
import { AdaptiveSheet, SheetAction } from "@/src/components/AdaptiveSheet";
import { MessageBubble, StreamCard } from "@/src/components/MessageContent";
import { ModelSelectorSheet } from "@/src/components/ModelSelectorSheet";
import { TurnNavigatorSheet } from "@/src/components/TurnNavigatorSheet";
import { SpacePanels, type SpacePanel } from "@/src/components/SpacePanels";
import { useApp, useSession } from "@/src/data/context";
import { nextChatTailFollowing } from "@/src/data/chat-scroll";
import type { AttachmentDraft, ChatModelSelection } from "@/src/data/types";
import { mergeDisplayMessages, messageIndexForTurn, messagesFromTurns, turnSequenceForMessage } from "@/src/data/session-history";
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
  const { state, client, connectionState, sendMessage, abortSession, refreshSession, loadOlderTurns, loadNewerTurns, loadTurnIndex, jumpToTurn, renameSession, getAccessToken, loadModels, loadModelStatus, models, modelsLoading, modelsError, modelStatus, modelStatusLoading, modelStatusError } = useApp();
  const view = useSession(sessionId);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ChatModelSelection | null>(null);
  const [modelOverride, setModelOverride] = useState(false);
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(null);
  const [turnNavigatorOpen, setTurnNavigatorOpen] = useState(false);
  const [loadingSequence, setLoadingSequence] = useState<number | null>(null);
  const [currentTurnSequence, setCurrentTurnSequence] = useState<number | null>(null);
  const pendingScrollSequence = useRef<number | null>(null);
  const handledDeepLinkTarget = useRef<string | null>(null);
  const listRef = useRef<FlatList>(null);
  const initialScrollDone = useRef(false);
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
    if (!followingTailRef.current || userDraggingRef.current || momentumScrollingRef.current || pendingScrollSequence.current !== null || turnScrollTargetRef.current !== null || followTailFrameRef.current !== null) return;
    followTailFrameRef.current = requestAnimationFrame(() => {
      followTailFrameRef.current = null;
      if (!followingTailRef.current || userDraggingRef.current || momentumScrollingRef.current || pendingScrollSequence.current !== null || turnScrollTargetRef.current !== null) return;
      listRef.current?.scrollToEnd({ animated });
    });
  }, []);
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const ordered = viewableItems
      .filter((item) => item.isViewable && item.item && typeof item.item === "object")
      .sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
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
    const first = ordered[0];
    if (first?.item) setCurrentTurnSequence(turnSequenceForMessage(first.item as { meta: Record<string, unknown> | null }));
  }, []);
  const session = view.session ?? state.sessions.find((item) => item.id === sessionId) ?? null;
  const sessionSummary = state.sessions.find((item) => item.id === sessionId) ?? null;
  const spaceId = view.space?.id ?? session?.spaceId ?? sessionSummary?.spaceId ?? "";
  const spaceName = view.space ? displaySpaceName(view.space) : sessionSummary?.space?.name || "Space";
  const spaceSessions = useMemo(() => state.sessions.filter((item) => item.spaceId === spaceId), [spaceId, state.sessions]);
  const messages = useMemo(() => {
    const history = messagesFromTurns(view.turns);
    return mergeDisplayMessages(history.length > 0 ? history : view.messages, history.length > 0 ? view.messages : [])
      .filter((message) => !isAssistantIntermediate(message) && hasRenderableMessage(message))
      .sort((a, b) => a.sequence - b.sequence);
  }, [view.messages, view.turns]);
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
  const running = view.sending || view.stream?.status === "pending" || view.stream?.status === "streaming";
  const voice = useNativeVoiceInput({ getAccessToken, onFinal: (text) => setInput((current) => current.trim() ? `${current.trim()} ${text}` : text) });

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
      listRef.current.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset: 8 });
    }, retry === 0 ? 120 : 180);
  }, [targetMessageIndex]);
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
    listRef.current.scrollToIndex({ index, animated: retry === 0, viewPosition: 0, viewOffset: 8 });
    scheduleTurnScrollRetry(sequence, retry);
    setCurrentTurnSequence(sequence);
  }, [scheduleTurnScrollRetry, setFollowingTail, targetMessageIndex]);

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
    if (!view.stream || !followingTailRef.current || pendingScrollSequence.current !== null || turnScrollTargetRef.current !== null) return;
    requestFollowTail();
  }, [requestFollowTail, view.stream]);

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
    void (async () => {
      try {
        const sequence = await jumpToTurn(sessionId, target);
        pendingScrollSequence.current = sequence;
        scrollToTurn(sequence);
      } catch (error) {
        setNotice({ title: "Turn unavailable", message: error instanceof Error ? error.message : "Unable to open the requested part of the Chat." });
      }
    })();
  }, [client, initialTurnId, initialTurnSequence, jumpToTurn, scrollToTurn, sessionId, spaceId, view.historyLoaded]);

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
  const openRename = () => { setRenameValue(session ? displaySessionTitle(session) : ""); setRenameOpen(true); };
  const saveRename = async () => {
    try { await renameSession(sessionId, renameValue); setRenameOpen(false); } catch (error) { setNotice({ title: "Rename failed", message: error instanceof Error ? error.message : "Unable to rename this Chat." }); }
  };
  const handleScroll = useCallback((event: ChatScrollEvent) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceToBottom = Math.max(0, contentSize.height - layoutMeasurement.height - contentOffset.y);
    setFollowingTail(nextChatTailFollowing({
      currentlyFollowing: followingTailRef.current,
      distanceToBottom,
      userInteracting: userDraggingRef.current || momentumScrollingRef.current,
      pendingTarget: pendingScrollSequence.current !== null || (turnScrollTargetRef.current !== null && !targetIsLatestMessage()),
    }));
    if (initialScrollDone.current && contentOffset.y < 180 && view.hasMoreOlder && !view.loadingOlder) void loadOlderTurns(sessionId);
    if (distanceToBottom < 180 && view.hasMoreNewer && !view.loadingNewer) void loadNewerTurns(sessionId);
  }, [loadNewerTurns, loadOlderTurns, sessionId, setFollowingTail, targetIsLatestMessage, view.hasMoreNewer, view.hasMoreOlder, view.loadingNewer, view.loadingOlder]);

  const handleContentSizeChange = useCallback(() => {
    const pending = pendingScrollSequence.current;
    if (pending !== null) {
      scrollToTurn(pending);
      if (pendingScrollSequence.current !== null) return;
      initialScrollDone.current = true;
      return;
    }
    if (!initialScrollDone.current && messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: false });
      setFollowingTail(true);
      setCurrentTurnSequence(view.turns.at(-1)?.sequence ?? null);
      initialScrollDone.current = true;
      return;
    }
    requestFollowTail();
  }, [messages.length, requestFollowTail, scrollToTurn, setFollowingTail, view.turns]);

  const handleScrollToIndexFailed = useCallback(({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
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
    listRef.current?.scrollToOffset({ offset: Math.max(0, index * Math.max(averageItemLength, 1)), animated: false });
    requestAnimationFrame(() => {
      if (turnScrollTargetRef.current === target) scrollToTurn(target, retries + 1);
    });
  }, [scrollToTurn]);

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
    const distanceToBottom = Math.max(0, contentSize.height - layoutMeasurement.height - contentOffset.y);
    setFollowingTail(nextChatTailFollowing({ currentlyFollowing: followingTailRef.current, distanceToBottom, userInteracting: false, pendingTarget: pendingScrollSequence.current !== null || turnScrollTargetRef.current !== null }));
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
    const distanceToBottom = Math.max(0, contentSize.height - layoutMeasurement.height - contentOffset.y);
    setFollowingTail(nextChatTailFollowing({ currentlyFollowing: followingTailRef.current, distanceToBottom, userInteracting: false, pendingTarget: pendingScrollSequence.current !== null || (turnScrollTargetRef.current !== null && !targetIsLatestMessage()) }));
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
        <DetailTopBar title={session ? displaySessionTitle(session) : "Chat"} subtitle={spaceName} onBack={() => router.back()} actions={<><IconButton name="list-tree" label="Open conversation turns" size={38} onPress={() => setTurnNavigatorOpen(true)} disabled={view.turnIndex.length === 0 && view.loading} /><IconButton name="messages" label="Open Chats" size={38} onPress={() => setActivePanel("chat")} disabled={!spaceId} /><IconButton name="folder-open" label="Open Files" size={38} onPress={() => setActivePanel("files")} disabled={!spaceId} /><IconButton name="more" label="More actions" size={38} onPress={openRename} /></>} />
        <ConnectionBanner state={connectionState} />
        {view.error ? <Pressable onPress={() => void refreshSession(sessionId)} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ marginHorizontal: 16, marginTop: 12, padding: 11, borderRadius: 12, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.dangerSoft, flexDirection: "row", alignItems: "center", gap: 8 })}><AppIcon name="alert" size={16} color={theme.colors.danger} /><Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{view.error}</Text><Text style={[typography.caption, { color: theme.colors.danger }]}>Retry</Text></Pressable> : null}
        <FlatList ref={listRef} data={messages} keyExtractor={(item) => item.id} renderItem={({ item, index }) => { const sequence = turnSequenceForMessage(item); const previousSequence = index > 0 ? turnSequenceForMessage(messages[index - 1]!) : null; const showTurnMarker = sequence !== null && sequence !== previousSequence; const turn = sequence === null ? null : view.turnIndex.find((entry) => entry.sequence === sequence); return <View>{showTurnMarker ? <TurnMarker sequence={sequence} status={turn?.status} /> : null}<MessageBubble message={item} local={item.meta?.optimistic === true} /></View>; }} keyboardShouldPersistTaps="handled" maintainVisibleContentPosition={{ minIndexForVisible: 0 }} viewabilityConfig={messageViewabilityConfig} onViewableItemsChanged={onViewableItemsChanged} scrollEventThrottle={100} onScroll={handleScroll} onScrollBeginDrag={handleScrollBeginDrag} onScrollEndDrag={handleScrollEndDrag} onMomentumScrollBegin={handleMomentumScrollBegin} onMomentumScrollEnd={handleMomentumScrollEnd} contentContainerStyle={{ paddingTop: 12, paddingBottom: 12, flexGrow: messages.length === 0 ? 1 : undefined }} onContentSizeChange={handleContentSizeChange} onScrollToIndexFailed={handleScrollToIndexFailed} onRefresh={() => void refreshSession(sessionId)} refreshing={view.refreshing} ListHeaderComponent={view.hasMoreOlder ? <Pressable accessibilityRole="button" accessibilityLabel="Load earlier turns" disabled={view.loadingOlder} onPress={() => void loadOlderTurns(sessionId)} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ minHeight: 42, marginHorizontal: 16, marginBottom: 8, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}>{view.loadingOlder ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>Load earlier turns</Text>}</Pressable> : null} ListEmptyComponent={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 28 }}><View style={{ width: 52, height: 52, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accentSoft }}><AppIcon name="sparkles" size={23} color={theme.colors.accent} /></View><Text style={[typography.heading, { color: theme.colors.text, marginTop: 14 }]}>A fresh Space for thinking</Text><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center", marginTop: 6, maxWidth: 290 }]}>Send a prompt to start working with the Agent.</Text></View>} ListFooterComponent={<View>{view.hasMoreNewer ? <Pressable accessibilityRole="button" accessibilityLabel="Load newer turns" disabled={view.loadingNewer} onPress={() => void loadNewerTurns(sessionId)} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ minHeight: 42, marginHorizontal: 16, marginTop: 8, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}>{view.loadingNewer ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>Load newer turns</Text>}</Pressable> : null}{view.stream ? <StreamCard content={view.stream.contentBlocks} status={view.stream.status} /> : null}</View>} />
        {attachments.length > 0 ? <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 7, backgroundColor: theme.colors.background }}>{attachments.map((attachment, index) => <AttachmentChip key={`${attachment.uri}-${index}`} name={attachment.name} onRemove={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</View> : null}
        {voice.partial || voice.error ? <View style={{ paddingHorizontal: 16, paddingTop: 5, backgroundColor: theme.colors.background }}><Text style={[typography.caption, { color: voice.error ? theme.colors.danger : theme.colors.textMuted }]}>{voice.error ? voice.error : `Listening · ${voice.partial}`}</Text></View> : null}
        {!followingTail ? <View style={{ alignItems: "flex-end", paddingHorizontal: 16, paddingBottom: 4, backgroundColor: theme.colors.background }}><IconButton name="arrow-down" label="Jump to latest" size={38} tone="accent" onPress={() => { cancelTurnScroll(); setFollowingTail(true); requestFollowTail(true); }} /></View> : null}
        <ComposerInput value={input} onChangeText={setInput} onSend={() => void submit()} onStop={() => void stopGeneration()} onAttach={() => setAttachmentMenuOpen(true)} sending={view.sending} onVoice={() => voice.isRecording ? voice.stop() : void voice.start()} onModelPress={() => { void Promise.all([loadModels(), loadModelStatus()]).catch(() => undefined); setModelSelectorOpen(true); }} modelLabel={modelTriggerLabel} modelStatus={activeStatus} voiceActive={voice.isRecording} voiceStarting={voice.isStarting} disabled={view.loading || stopping} running={running} hasAttachment={attachments.length > 0} placeholder={running ? "Agent is working…" : "Message the Agent"} />
        <AdaptiveSheet visible={attachmentMenuOpen} title="Add to Chat" subtitle="Choose what to include with your next message." onClose={() => setAttachmentMenuOpen(false)} scrollable={false} testID="chat-attachment-sheet"><SheetAction icon="images" title="Photo library" detail="Choose one or more images" onPress={() => void pickPhotos()} /><SheetAction icon="camera" title="Take a photo" detail="Use the device camera" onPress={() => void takePhoto()} /><SheetAction icon="paperclip" title="Choose a file" detail="Attach a document or archive" onPress={() => void pickAttachments()} /></AdaptiveSheet>
        <TurnNavigatorSheet visible={turnNavigatorOpen} turns={view.turnIndex} currentSequence={currentTurnSequence} loading={view.turnIndexLoading} loadingSequence={loadingSequence} onClose={() => setTurnNavigatorOpen(false)} onJump={(sequence) => handleTurnJump(sequence)} onRetry={() => void loadTurnIndex(sessionId, { force: true }).catch(() => undefined)} />
        <ModelSelectorSheet key={modelSelectorOpen ? "chat-model-open" : "chat-model-closed"} visible={modelSelectorOpen} models={models} loading={modelsLoading} error={modelsError || modelStatusError} modelStatus={modelStatus?.models ?? null} modelStatusLoading={modelStatusLoading} currentModel={modelOverride ? selectedModel : recordedModel} onClose={() => setModelSelectorOpen(false)} onRetry={() => void Promise.all([loadModels({ force: true }), loadModelStatus({ force: true })]).catch(() => undefined)} onSelect={(model) => { setSelectedModel(model); setModelOverride(true); setModelSelectorOpen(false); }} />
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
