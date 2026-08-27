import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { MessageBubble, StreamCard } from "@/src/components/MessageContent";
import { useApp, useSession } from "@/src/data/context";
import type { AttachmentDraft } from "@/src/data/types";
import { useAppTheme, typography } from "@/src/theme";
import { useNativeVoiceInput } from "@/src/platform/native-voice-input";
import { AppIcon, AttachmentChip, ComposerInput, ConnectionBanner, IconButton, PrimaryButton, Screen, TopBar } from "@/src/ui";
import { displaySessionTitle, displaySpaceName } from "@/src/utils";

type RouteParams = { sessionId?: string | string[] };

export default function ChatScreen() {
  const params = useLocalSearchParams<RouteParams>();
  const sessionId = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId;
  if (!sessionId) return <MissingChat />;
  return <ChatContent sessionId={sessionId} />;
}

function ChatContent({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, connectionState, sendMessage, abortSession, refreshSession, renameSession, getAccessToken } = useApp();
  const view = useSession(sessionId);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [stopping, setStopping] = useState(false);
  const listRef = useRef<FlatList>(null);
  const initialScrollDone = useRef(false);
  const session = view.session ?? state.sessions.find((item) => item.id === sessionId) ?? null;
  const sessionSummary = state.sessions.find((item) => item.id === sessionId) ?? null;
  const spaceName = view.space ? displaySpaceName(view.space) : sessionSummary?.space?.name || "Space";
  const messages = useMemo(() => [...view.messages].sort((a, b) => a.sequence - b.sequence), [view.messages]);
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
      Alert.alert("Attachment unavailable", error instanceof Error ? error.message : "Unable to select a file.");
    }
  };

  const pickPhotos = async () => {
    setAttachmentMenuOpen(false);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Photo access is off", "Allow photo access in system settings to attach an image.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 0.88 });
      if (result.canceled) return;
      appendAttachments(result.assets.map((asset, index) => ({ uri: asset.uri, name: asset.fileName || `image-${index + 1}.jpg`, mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 })));
    } catch (error) {
      Alert.alert("Photo picker unavailable", error instanceof Error ? error.message : "Unable to select a photo.");
    }
  };

  const takePhoto = async () => {
    setAttachmentMenuOpen(false);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Camera access is off", "Allow camera access in system settings to take a photo.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.88 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset) appendAttachments([{ uri: asset.uri, name: asset.fileName || "camera-photo.jpg", mimeType: asset.mimeType || "image/jpeg", size: asset.fileSize ?? 0 }]);
    } catch (error) {
      Alert.alert("Camera unavailable", error instanceof Error ? error.message : "Unable to take a photo.");
    }
  };

  const stopGeneration = async () => {
    if (stopping) return;
    setStopping(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await abortSession(sessionId);
    } catch (error) {
      Alert.alert("Unable to stop", error instanceof Error ? error.message : "The Agent could not be stopped.");
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
      Alert.alert("Rename failed", error instanceof Error ? error.message : "Unable to rename this Chat.");
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
      await sendMessage(sessionId, text, files);
    } catch {
      setInput(text);
      setAttachments(files);
    }
  };

  if (view.loading && !session && view.messages.length === 0) {
    return <Screen><TopBar title="Chat" left={<IconButton name="arrow-back" label="Back" size={40} onPress={() => router.back()} />} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>Opening Chat…</Text></View></Screen>;
  }

  return <Screen keyboard>
    <TopBar
      title={session ? displaySessionTitle(session) : "Chat"}
      subtitle={spaceName}
      left={<IconButton name="arrow-back" label="Back" size={40} onPress={() => router.back()} />}
      right={<><IconButton name="folder-open-outline" label="Open Files" size={38} onPress={() => view.space ? router.push({ pathname: "/space/[spaceId]/files", params: { spaceId: view.space.id } }) : undefined} disabled={!view.space} /><IconButton name="ellipsis-horizontal" label="More actions" size={38} onPress={openRename} /></>}
    />
    <ConnectionBanner state={connectionState} />
    {view.error ? <Pressable onPress={() => void refreshSession(sessionId)} style={{ marginHorizontal: 16, marginTop: 12, padding: 11, borderRadius: 12, backgroundColor: theme.colors.dangerSoft, flexDirection: "row", alignItems: "center", gap: 8 }}><AppIcon name="alert-circle-outline" size={16} color={theme.colors.danger} /><Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{view.error}</Text><Text style={[typography.caption, { color: theme.colors.danger }]}>Retry</Text></Pressable> : null}
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
      ListEmptyComponent={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 28 }}><View style={{ width: 52, height: 52, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accentSoft }}><AppIcon name="sparkles-outline" size={23} color={theme.colors.accent} /></View><Text style={[typography.heading, { color: theme.colors.text, marginTop: 14 }]}>A fresh Space for thinking</Text><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center", marginTop: 6, maxWidth: 290 }]}>Send a prompt to start working with the Agent.</Text></View>}
      ListFooterComponent={view.stream ? <StreamCard content={view.stream.contentBlocks} status={view.stream.status} /> : null}
    />
    {attachments.length > 0 ? <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 7, backgroundColor: theme.colors.background }}>{attachments.map((attachment, index) => <AttachmentChip key={`${attachment.uri}-${index}`} name={attachment.name} onRemove={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</View> : null}
    {voice.partial || voice.error ? <View style={{ paddingHorizontal: 16, paddingTop: 5, backgroundColor: theme.colors.background }}><Text style={[typography.caption, { color: voice.error ? theme.colors.danger : theme.colors.textMuted }]}>{voice.error ? voice.error : `Listening · ${voice.partial}`}</Text></View> : null}
    <ComposerInput value={input} onChangeText={setInput} onSend={() => void submit()} onStop={() => void stopGeneration()} onAttach={() => setAttachmentMenuOpen(true)} onVoice={() => voice.isRecording ? voice.stop() : void voice.start()} voiceActive={voice.isRecording} voiceStarting={voice.isStarting} disabled={view.loading || stopping} running={running} hasAttachment={attachments.length > 0} placeholder={running ? "Agent is working…" : "Message the Agent"} />

    <Modal visible={attachmentMenuOpen} transparent animationType="slide" onRequestClose={() => setAttachmentMenuOpen(false)}>
      <Pressable style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" }} onPress={() => setAttachmentMenuOpen(false)}>
        <Pressable style={{ padding: 16, paddingBottom: 28, borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: theme.colors.surface }} onPress={(event) => event.stopPropagation()}>
          <View style={{ width: 34, height: 4, borderRadius: 2, alignSelf: "center", backgroundColor: theme.colors.borderStrong, marginBottom: 18 }} />
          <Text style={[typography.heading, { color: theme.colors.text, marginBottom: 10 }]}>Add to Chat</Text>
          <SheetAction icon="images-outline" title="Photo library" detail="Choose one or more images" onPress={() => void pickPhotos()} />
          <SheetAction icon="camera-outline" title="Take a photo" detail="Use the device camera" onPress={() => void takePhoto()} />
          <SheetAction icon="document-attach-outline" title="Choose a file" detail="Attach a document or archive" onPress={() => void pickAttachments()} />
          <Pressable onPress={() => setAttachmentMenuOpen(false)} style={{ minHeight: 46, alignItems: "center", justifyContent: "center", marginTop: 5 }}><Text style={[typography.bodyMedium, { color: theme.colors.textMuted }]}>Cancel</Text></Pressable>
        </Pressable>
      </Pressable>
    </Modal>

    <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
      <View style={{ flex: 1, justifyContent: "center", padding: 22, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <View style={{ borderRadius: 18, padding: 18, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }}>
          <Text style={[typography.heading, { color: theme.colors.text }]}>Rename Chat</Text>
          <TextInput autoFocus value={renameValue} onChangeText={setRenameValue} maxLength={80} placeholder="Chat name" placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 48, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, paddingHorizontal: 12, marginTop: 14 }]} />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 }}><Pressable onPress={() => setRenameOpen(false)} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center" }}><Text style={[typography.bodyMedium, { color: theme.colors.textMuted }]}>Cancel</Text></Pressable><PrimaryButton label="Save" onPress={() => void saveRename()} style={{ minHeight: 44, paddingHorizontal: 16 }} /></View>
        </View>
      </View>
    </Modal>
  </Screen>;
}

function SheetAction({ icon, title, detail, onPress }: { icon: React.ComponentProps<typeof AppIcon>["name"]; title: string; detail: string; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable onPress={onPress} style={({ pressed }) => ({ minHeight: 58, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 8, borderRadius: 12, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}><View style={{ width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accentSoft }}><AppIcon name={icon} size={18} color={theme.colors.accent} /></View><View style={{ flex: 1 }}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{title}</Text><Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{detail}</Text></View><AppIcon name="chevron-forward" size={17} color={theme.colors.textFaint} /></Pressable>;
}

function MissingChat() {
  const router = useRouter();
  const theme = useAppTheme();
  return <Screen><TopBar title="Chat" left={<IconButton name="arrow-back" label="Back" size={40} onPress={() => router.back()} />} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>This Chat could not be found.</Text></View></Screen>;
}
