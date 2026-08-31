import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { AdaptiveSheet, SheetAction } from "@/src/components/AdaptiveSheet";
import { MessageBubble, StreamCard } from "@/src/components/MessageContent";
import { ModelSelectorSheet } from "@/src/components/ModelSelectorSheet";
import { SpacePanels, type SpacePanel } from "@/src/components/SpacePanels";
import { useApp, useSession } from "@/src/data/context";
import type { AttachmentDraft, ChatModelSelection } from "@/src/data/types";
import { useAppTheme, typography } from "@/src/theme";
import { useNativeVoiceInput } from "@/src/platform/native-voice-input";
import { AppIcon, AttachmentChip, ComposerInput, ConnectionBanner, DetailTopBar, IconButton, PrimaryButton, Screen } from "@/src/ui";
import { displaySessionTitle, displaySpaceName, hasRenderableMessage, isAssistantIntermediate } from "@/src/utils";

type RouteParams = { sessionId?: string | string[]; spaceId?: string | string[] };

export default function ChatScreen() {
  const params = useLocalSearchParams<RouteParams>();
  const sessionId = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId;
  const spaceId = Array.isArray(params.spaceId) ? params.spaceId[0] : params.spaceId;
  if (!sessionId) return <MissingChat />;
  if (sessionId === "new") return spaceId ? <DraftChatContent spaceId={spaceId} /> : <MissingChat />;
  return <ChatContent key={sessionId} sessionId={sessionId} />;
}

function ChatContent({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, client, connectionState, sendMessage, abortSession, refreshSession, renameSession, getAccessToken, loadModels, models, modelsLoading, modelsError } = useApp();
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
  const listRef = useRef<FlatList>(null);
  const initialScrollDone = useRef(false);
  const session = view.session ?? state.sessions.find((item) => item.id === sessionId) ?? null;
  const sessionSummary = state.sessions.find((item) => item.id === sessionId) ?? null;
  const spaceId = view.space?.id ?? session?.spaceId ?? sessionSummary?.spaceId ?? "";
  const spaceName = view.space ? displaySpaceName(view.space) : sessionSummary?.space?.name || "Space";
  const spaceSessions = useMemo(
    () => state.sessions.filter((item) => item.spaceId === spaceId),
    [spaceId, state.sessions],
  );
  const messages = useMemo(
    () => view.messages.filter((message) => !isAssistantIntermediate(message) && hasRenderableMessage(message)).sort((a, b) => a.sequence - b.sequence),
    [view.messages],
  );
  let recordedModel: ChatModelSelection | null = null;
  for (const message of [...messages].reverse()) {
    if (message.meta?.messageKind === "generation_result" || message.provider === "generation") continue;
    if (message.model) {
      const provider = message.provider || "cohub";
      const catalogItem = models.find((item) => item.provider === provider && item.id === message.model);
      const name = catalogItem?.model?.name;
      recordedModel = {
        provider,
        id: message.model,
        ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
      };
      break;
    }
  }
  const activeModel = modelOverride ? selectedModel : recordedModel;
  const modelLabel = activeModel?.name || activeModel?.id || "Automatic";
  const running = view.sending || view.stream?.status === "pending" || view.stream?.status === "streaming";
  const voice = useNativeVoiceInput({
    getAccessToken,
    onFinal: (text) => setInput((current) => current.trim() ? `${current.trim()} ${text}` : text),
  });

  useEffect(() => {
    initialScrollDone.current = false;
  }, [sessionId]);

  const appendAttachments = (next: AttachmentDraft[]) => {
    setAttachments((current) => [...current, ...next].slice(0, 6));
  };

  const pickAttachments = async () => {
    setAttachmentMenuOpen(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      appendAttachments(result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType || "application/octet-stream", size: asset.size ?? 0 })));
    } catch (error) {
      setNotice({ title: "Attachment unavailable", message: error instanceof Error ? error.message : "Unable to select a file." });
    }
  };

  const pickPhotos = async () => {
    setAttachmentMenuOpen(false);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setNotice({ title: "Photo access is off", message: "Allow photo access in system settings to attach an image." });
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 0.88 });
      if (result.canceled) return;
      appendAttachments(result.assets.map((asset, index) => ({ uri: asset.uri, name: asset.fileName || `image-${index + 1}.jpg`, mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 })));
    } catch (error) {
      setNotice({ title: "Photo picker unavailable", message: error instanceof Error ? error.message : "Unable to select a photo." });
    }
  };

  const takePhoto = async () => {
    setAttachmentMenuOpen(false);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setNotice({ title: "Camera access is off", message: "Allow camera access in system settings to take a photo." });
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.88 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset) appendAttachments([{ uri: asset.uri, name: asset.fileName || "camera-photo.jpg", mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 }]);
    } catch (error) {
      setNotice({ title: "Camera unavailable", message: error instanceof Error ? error.message : "Unable to take a photo." });
    }
  };

  const stopGeneration = async () => {
    if (stopping) return;
    setStopping(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await abortSession(sessionId);
    } catch (error) {
      setNotice({ title: "Unable to stop", message: error instanceof Error ? error.message : "The Agent could not be stopped." });
    } finally {
      setStopping(false);
    }
  };

  const openRename = () => {
    setRenameValue(session ? displaySessionTitle(session) : "");
    setRenameOpen(true);
  };

  const saveRename = async () => {
    try {
      await renameSession(sessionId, renameValue);
      setRenameOpen(false);
    } catch (error) {
      setNotice({ title: "Rename failed", message: error instanceof Error ? error.message : "Unable to rename this Chat." });
    }
  };

  const submit = async () => {
    if ((!input.trim() && attachments.length === 0) || view.sending) return;
    const text = input;
    const files = attachments;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInput("");
    setAttachments([]);
    try {
      const requestModel = modelOverride ? selectedModel : recordedModel;
      await sendMessage(sessionId, text, files, requestModel ? { model: requestModel } : undefined);
    } catch {
      setInput(text);
      setAttachments(files);
    }
  };

  if (view.loading && !session && view.messages.length === 0) {
    return <Screen><DetailTopBar title="Chat" onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>Opening Chat…</Text></View></Screen>;
  }

  return <Screen keyboard>
    <SpacePanels
      key={spaceId || sessionId}
      spaceId={spaceId}
      spaceName={spaceName}
      sessions={spaceSessions}
      client={client}
      activePanel={activePanel}
      onActivePanelChange={setActivePanel}
      onOpenSession={(nextSessionId) => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: nextSessionId } })}
      onNewChat={() => spaceId ? router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId } }) : undefined}
      onOpenFile={(path) => spaceId ? router.push({ pathname: "/space/[spaceId]/file", params: { spaceId, path } }) : undefined}
      onOpenFilesPage={() => spaceId ? router.push({ pathname: "/space/[spaceId]/files", params: { spaceId } }) : undefined}
    >
      <View style={{ flex: 1 }}>
    <DetailTopBar
      title={session ? displaySessionTitle(session) : "Chat"}
      subtitle={spaceName}
      onBack={() => router.back()}
      actions={<><IconButton name="messages" label="Open Chats" size={38} onPress={() => setActivePanel("chat")} disabled={!spaceId} /><IconButton name="folder-open" label="Open Files" size={38} onPress={() => setActivePanel("files")} disabled={!spaceId} /><IconButton name="more" label="More actions" size={38} onPress={openRename} /></>}
    />
    <ConnectionBanner state={connectionState} />
    {view.error ? <Pressable onPress={() => void refreshSession(sessionId)} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ marginHorizontal: 16, marginTop: 12, padding: 11, borderRadius: 12, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.dangerSoft, flexDirection: "row", alignItems: "center", gap: 8 })}><AppIcon name="alert" size={16} color={theme.colors.danger} /><Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{view.error}</Text><Text style={[typography.caption, { color: theme.colors.danger }]}>Retry</Text></Pressable> : null}
    <FlatList
      ref={listRef}
      data={messages}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <MessageBubble message={item} local={item.meta?.optimistic === true} />}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: 12, paddingBottom: 12, flexGrow: messages.length === 0 ? 1 : undefined }}
      onContentSizeChange={() => {
        if (!initialScrollDone.current) {
          listRef.current?.scrollToEnd({ animated: false });
          initialScrollDone.current = true;
        }
      }}
      onRefresh={() => void refreshSession(sessionId)}
      refreshing={view.refreshing}
      ListEmptyComponent={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 28 }}><View style={{ width: 52, height: 52, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accentSoft }}><AppIcon name="sparkles" size={23} color={theme.colors.accent} /></View><Text style={[typography.heading, { color: theme.colors.text, marginTop: 14 }]}>A fresh Space for thinking</Text><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center", marginTop: 6, maxWidth: 290 }]}>Send a prompt to start working with the Agent.</Text></View>}
      ListFooterComponent={view.stream ? <StreamCard content={view.stream.contentBlocks} status={view.stream.status} /> : null}
    />
    {attachments.length > 0 ? <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 7, backgroundColor: theme.colors.background }}>{attachments.map((attachment, index) => <AttachmentChip key={`${attachment.uri}-${index}`} name={attachment.name} onRemove={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</View> : null}
    {voice.partial || voice.error ? <View style={{ paddingHorizontal: 16, paddingTop: 5, backgroundColor: theme.colors.background }}><Text style={[typography.caption, { color: voice.error ? theme.colors.danger : theme.colors.textMuted }]}>{voice.error ? voice.error : `Listening · ${voice.partial}`}</Text></View> : null}
    <ComposerInput value={input} onChangeText={setInput} onSend={() => void submit()} onStop={() => void stopGeneration()} onAttach={() => setAttachmentMenuOpen(true)} onVoice={() => voice.isRecording ? voice.stop() : void voice.start()} onModelPress={() => { void loadModels().catch(() => undefined); setModelSelectorOpen(true); }} modelLabel={modelLabel} voiceActive={voice.isRecording} voiceStarting={voice.isStarting} disabled={view.loading || stopping} running={running} hasAttachment={attachments.length > 0} placeholder={running ? "Agent is working…" : "Message the Agent"} />

    <AdaptiveSheet
      visible={attachmentMenuOpen}
      title="Add to Chat"
      subtitle="Choose what to include with your next message."
      onClose={() => setAttachmentMenuOpen(false)}
      scrollable={false}
      testID="chat-attachment-sheet"
    >
      <SheetAction icon="images" title="Photo library" detail="Choose one or more images" onPress={() => void pickPhotos()} />
      <SheetAction icon="camera" title="Take a photo" detail="Use the device camera" onPress={() => void takePhoto()} />
      <SheetAction icon="paperclip" title="Choose a file" detail="Attach a document or archive" onPress={() => void pickAttachments()} />
    </AdaptiveSheet>

    <ModelSelectorSheet
      key={modelSelectorOpen ? "chat-model-open" : "chat-model-closed"}
      visible={modelSelectorOpen}
      models={models}
      loading={modelsLoading}
      error={modelsError}
      currentModel={modelOverride ? selectedModel : recordedModel}
      onClose={() => setModelSelectorOpen(false)}
      onRetry={() => void loadModels({ force: true }).catch(() => undefined)}
      onSelect={(model) => {
        setSelectedModel(model);
        setModelOverride(true);
        setModelSelectorOpen(false);
      }}
    />

    <AdaptiveSheet
      visible={notice !== null}
      title={notice?.title ?? "Notice"}
      onClose={() => setNotice(null)}
      scrollable={false}
      footer={<View style={{ alignItems: "flex-end" }}><PrimaryButton label="Done" onPress={() => setNotice(null)} style={{ minHeight: 44, paddingHorizontal: 18 }} /></View>}
      testID="chat-notice-sheet"
    >
      <Text style={[typography.body, { color: theme.colors.textSecondary }]}>{notice?.message ?? ""}</Text>
    </AdaptiveSheet>

    <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
      <View style={{ flex: 1, justifyContent: "center", padding: 22, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <View style={{ borderRadius: 18, padding: 18, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }}>
          <Text style={[typography.heading, { color: theme.colors.text }]}>Rename Chat</Text>
          <TextInput autoFocus value={renameValue} onChangeText={setRenameValue} maxLength={80} placeholder="Chat name" placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 48, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, paddingHorizontal: 12, marginTop: 14 }]} />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 }}><Pressable onPress={() => setRenameOpen(false)} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center" }}><Text style={[typography.bodyMedium, { color: theme.colors.textMuted }]}>Cancel</Text></Pressable><PrimaryButton label="Save" onPress={() => void saveRename()} style={{ minHeight: 44, paddingHorizontal: 16 }} /></View>
        </View>
      </View>
    </Modal>
      </View>
    </SpacePanels>
  </Screen>;
}

function DraftChatContent({ spaceId }: { spaceId: string }) {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, client, connectionState, sendNewMessage, getAccessToken, loadModels, models, modelsLoading, modelsError } = useApp();
  const space = state.spaces.find((item) => item.id === spaceId) ?? null;
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ChatModelSelection | null>(null);
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const voice = useNativeVoiceInput({
    getAccessToken,
    onFinal: (text) => setInput((current) => current.trim() ? `${current.trim()} ${text}` : text),
  });

  const appendAttachments = (next: AttachmentDraft[]) => {
    setAttachments((current) => [...current, ...next].slice(0, 6));
  };

  const pickAttachments = async () => {
    setAttachmentMenuOpen(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      appendAttachments(result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType || "application/octet-stream", size: asset.size ?? 0 })));
    } catch (error) {
      setNotice({ title: "Attachment unavailable", message: error instanceof Error ? error.message : "Unable to select a file." });
    }
  };

  const pickPhotos = async () => {
    setAttachmentMenuOpen(false);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setNotice({ title: "Photo access is off", message: "Allow photo access in system settings to attach an image." });
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 0.88 });
      if (result.canceled) return;
      appendAttachments(result.assets.map((asset, index) => ({ uri: asset.uri, name: asset.fileName || `image-${index + 1}.jpg`, mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 })));
    } catch (error) {
      setNotice({ title: "Photo picker unavailable", message: error instanceof Error ? error.message : "Unable to select a photo." });
    }
  };

  const takePhoto = async () => {
    setAttachmentMenuOpen(false);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setNotice({ title: "Camera access is off", message: "Allow camera access in system settings to take a photo." });
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.88 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset) appendAttachments([{ uri: asset.uri, name: asset.fileName || "camera-photo.jpg", mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 }]);
    } catch (error) {
      setNotice({ title: "Camera unavailable", message: error instanceof Error ? error.message : "Unable to take a photo." });
    }
  };

  const submit = async () => {
    if (!space || sending || (!input.trim() && attachments.length === 0)) return;
    const text = input;
    const files = attachments;
    setInput("");
    setAttachments([]);
    setSending(true);
    try {
      const session = await sendNewMessage(space.id, text, files, { model: selectedModel });
      router.replace({ pathname: "/chat/[sessionId]", params: { sessionId: session.id } });
    } catch (error) {
      setInput(text);
      setAttachments(files);
      setNotice({ title: "Chat could not start", message: error instanceof Error ? error.message : "Unable to start this Chat." });
    } finally {
      setSending(false);
    }
  };

  if (!space) {
    return <Screen><DetailTopBar title="Space unavailable" onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center" }]}>This Space is no longer available.</Text></View></Screen>;
  }

  const spaceName = displaySpaceName(space);
  const spaceSessions = state.sessions.filter((item) => item.spaceId === space.id);
  const modelLabel = selectedModel?.name || selectedModel?.id || "Automatic";
  return <Screen keyboard>
    <SpacePanels
      key={space.id}
      spaceId={space.id}
      spaceName={spaceName}
      sessions={spaceSessions}
      client={client}
      activePanel={activePanel}
      onActivePanelChange={setActivePanel}
      onOpenSession={(nextSessionId) => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: nextSessionId } })}
      onNewChat={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId: space.id } })}
      onOpenFile={(path) => router.push({ pathname: "/space/[spaceId]/file", params: { spaceId: space.id, path } })}
      onOpenFilesPage={() => router.push({ pathname: "/space/[spaceId]/files", params: { spaceId: space.id } })}
    >
      <View style={{ flex: 1 }}>
    <DetailTopBar
      title={spaceName}
      subtitle="Start a conversation"
      onBack={() => router.back()}
      actions={<><IconButton name="messages" label="Open Chats" size={38} onPress={() => setActivePanel("chat")} /><IconButton name="folder-open" label="Open Files" size={38} onPress={() => setActivePanel("files")} /></>}
    />
    <ConnectionBanner state={connectionState} />
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingBottom: 18 }}>
        <View style={{ width: 58, height: 58, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.accentBorder }}><AppIcon name="sparkles" size={26} color={theme.colors.accent} /></View>
        <Text style={[typography.title, { color: theme.colors.text, marginTop: 15, textAlign: "center" }]}>What are you working on?</Text>
        <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 7, textAlign: "center", maxWidth: 320 }]}>Your first message will become the conversation title automatically.</Text>
      </View>
      {attachments.length > 0 ? <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 7, backgroundColor: theme.colors.background }}>{attachments.map((attachment, index) => <AttachmentChip key={`${attachment.uri}-${index}`} name={attachment.name} onRemove={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</View> : null}
      {voice.partial || voice.error ? <View style={{ paddingHorizontal: 16, paddingTop: 5, backgroundColor: theme.colors.background }}><Text style={[typography.caption, { color: voice.error ? theme.colors.danger : theme.colors.textMuted }]}>{voice.error ? voice.error : `Listening · ${voice.partial}`}</Text></View> : null}
      <ComposerInput value={input} onChangeText={setInput} onSend={() => void submit()} onAttach={() => setAttachmentMenuOpen(true)} onVoice={() => voice.isRecording ? voice.stop() : void voice.start()} onModelPress={() => { void loadModels().catch(() => undefined); setModelSelectorOpen(true); }} modelLabel={modelLabel} voiceActive={voice.isRecording} voiceStarting={voice.isStarting} disabled={sending} hasAttachment={attachments.length > 0} placeholder={sending ? "Starting Chat…" : "Message the Agent"} />
    </View>

    <ModelSelectorSheet
      key={modelSelectorOpen ? "draft-model-open" : "draft-model-closed"}
      visible={modelSelectorOpen}
      models={models}
      loading={modelsLoading}
      error={modelsError}
      currentModel={selectedModel}
      onClose={() => setModelSelectorOpen(false)}
      onRetry={() => void loadModels({ force: true }).catch(() => undefined)}
      onSelect={(model) => {
        setSelectedModel(model);
        setModelSelectorOpen(false);
      }}
    />

    <AdaptiveSheet
      visible={attachmentMenuOpen}
      title="Add to Chat"
      subtitle="Choose what to include with your first message."
      onClose={() => setAttachmentMenuOpen(false)}
      scrollable={false}
      testID="new-chat-attachment-sheet"
    >
      <SheetAction icon="images" title="Photo library" detail="Choose one or more images" onPress={() => void pickPhotos()} />
      <SheetAction icon="camera" title="Take a photo" detail="Use the device camera" onPress={() => void takePhoto()} />
      <SheetAction icon="paperclip" title="Choose a file" detail="Attach a document or archive" onPress={() => void pickAttachments()} />
    </AdaptiveSheet>

    <AdaptiveSheet
      visible={notice !== null}
      title={notice?.title ?? "Notice"}
      onClose={() => setNotice(null)}
      scrollable={false}
      footer={<View style={{ alignItems: "flex-end" }}><PrimaryButton label="Done" onPress={() => setNotice(null)} style={{ minHeight: 44, paddingHorizontal: 18 }} /></View>}
      testID="new-chat-notice-sheet"
    >
      <Text style={[typography.body, { color: theme.colors.textSecondary }]}>{notice?.message ?? ""}</Text>
    </AdaptiveSheet>
      </View>
    </SpacePanels>
  </Screen>;
}

function MissingChat() {
  const router = useRouter();
  const theme = useAppTheme();
  return <Screen><DetailTopBar title="Chat" onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>This Chat could not be found.</Text></View></Screen>;
}
