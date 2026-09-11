import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import * as Updates from "expo-updates";
import { useIsFocused, useRouter } from "expo-router";
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FlatList, Platform, Pressable, ScrollView, Share, Switch, Text, View, useWindowDimensions } from "react-native";
import type { MessageRecord } from "@neta-art/cohub";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageBubble } from "@/src/components/MessageContent";
import { useToast } from "@/src/components/Toast";
import { useChatScrollTrace, useTraceTouches } from "@/src/components/use-chat-scroll-trace";
import { chatScrollTrace } from "@/src/data/chat-scroll-trace";
import { useApp } from "@/src/data/context";
import { typography, useAppTheme } from "@/src/theme";
import { DetailTopBar, IconButton, Screen } from "@/src/ui";

const PARAGRAPH = Array.from({ length: 100 }, (_, index) => `Line ${String(index + 1).padStart(3, "0")}: This section records a detailed review of a mobile conversation. Each numbered line belongs to the same continuous paragraph.`).join("\n");
const MARKDOWN = Array.from({ length: 18 }, (_, index) => `### Section ${index + 1}\n\n${Array.from({ length: 6 }, () => "A separate paragraph with **bold words**, plain text, and inline `code`.").join(" ")}\n\n- First list item\n- Second list item`).join("\n\n");
const messages: MessageRecord[] = [PARAGRAPH, MARKDOWN].map((text, index) => ({
  id: `scroll-fixture-${index}`, sessionId: "scroll-fixture", role: "assistant", text,
  content: [{ type: "text", text }], sequence: index + 1, provider: "cohub", model: "scroll-fixture",
  stopReason: "stop", errorMessage: null, usage: null, meta: null, authorUuid: null, authorProfile: null,
  startedAt: null, completedAt: null, durationMs: 0, createdAt: "2026-09-11T00:00:00.000Z",
}));

export default function ChatScrollDebugScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const toast = useToast();
  const { state } = useApp();
  const dimensions = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [tab, setTab] = useState<"Test" | "Chats" | "Logs">("Test");
  const [inverted, setInverted] = useState(true);
  const [focusScroll, setFocusScroll] = useState(true);
  const [fixture, setFixture] = useState(0);
  const [snapshot, setSnapshot] = useState(() => chatScrollTrace.snapshot());
  const recording = useSyncExternalStore(chatScrollTrace.subscribe, chatScrollTrace.isRecording, chatScrollTrace.isRecording);
  const refresh = useCallback(() => setSnapshot(chatScrollTrace.snapshot()), []);
  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(refresh, 500);
    return () => clearInterval(timer);
  }, [focused, refresh]);
  const start = () => {
    chatScrollTrace.start({ platform: Platform.OS, osVersion: String(Platform.Version), model: Device.modelName, appVersion: Application.nativeApplicationVersion, build: Application.nativeBuildVersion, runtime: Updates.runtimeVersion, updateId: Updates.updateId, embedded: Updates.isEmbeddedLaunch, width: dimensions.width, height: dimensions.height, fontScale: dimensions.fontScale, pixelRatio: dimensions.scale, theme: theme.mode, chatFontSize: typography.chatBody.fontSize, fixtureFocusScroll: focusScroll });
    refresh();
  };
  const exportLog = async (share: boolean) => {
    chatScrollTrace.pause();
    refresh();
    const text = chatScrollTrace.export();
    try {
      if (share) await Share.share({ title: "Chat scroll diagnostics", message: text });
      else { await Clipboard.setStringAsync(text); toast({ title: "Log copied" }); }
    } catch (error) {
      toast({ title: "Log export failed", message: error instanceof Error ? error.message : "Unable to export the log.", tone: "danger" });
    }
  };
  return <Screen contentStyle={{ paddingBottom: insets.bottom }}>
    <DetailTopBar title="Scroll Diagnostics" onBack={() => router.back()} actions={<>
      <IconButton name="copy" label="Copy complete log" onPress={() => void exportLog(false)} />
      <IconButton name="share" label="Share complete log" onPress={() => void exportLog(true)} />
    </>} />
    <View style={{ paddingHorizontal: 12, paddingVertical: 6, gap: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={[typography.bodyMedium, { color: theme.colors.text, flexGrow: 1 }]}>Recording</Text>
        <Switch accessibilityLabel="Record scroll diagnostics" value={recording} onValueChange={(enabled) => { if (!enabled) chatScrollTrace.pause(); else if (snapshot.startedAt) chatScrollTrace.resume(); else start(); refresh(); }} />
        <IconButton name="refresh" label="Start new recording" onPress={start} />
        <IconButton name="trash" label="Clear log" onPress={() => { chatScrollTrace.reset(); refresh(); }} />
        <IconButton name="bookmark" label="Mark experiment" disabled={!recording} onPress={() => { chatScrollTrace.record("experiment.mark", "debug", { tab, inverted, fixture, fixtureFocusScroll: focusScroll }); refresh(); }} />
      </View>
      <Text style={[typography.micro, { color: snapshot.dropped ? theme.colors.danger : theme.colors.textMuted }]}>{`${recording ? "Recording" : "Stopped"} | ${snapshot.entries.length}/4000 events | ${snapshot.dropped} overwritten`}</Text>
      <View style={{ flexDirection: "row" }}>{(["Test", "Chats", "Logs"] as const).map((value) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} onPress={() => { chatScrollTrace.record("debug.tab", "debug", { tab: value }); setTab(value); refresh(); }} style={{ flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderBottomWidth: 2, borderBottomColor: tab === value ? theme.colors.accent : "transparent" }}><Text style={[typography.bodyMedium, { color: tab === value ? theme.colors.accent : theme.colors.textMuted }]}>{value}</Text></Pressable>)}</View>
    </View>
    {tab === "Test" ? <>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 6 }}>
        <Text style={[typography.caption, { color: theme.colors.text, flex: 1 }]}>Inverted</Text>
        <Switch accessibilityLabel="Inverted test list" value={inverted} onValueChange={(value) => { chatScrollTrace.record("fixture.mode", "debug", { inverted: value, fixture }); setInverted(value); }} />
        {["Paragraph", "Markdown"].map((label, index) => <Pressable key={label} accessibilityRole="tab" accessibilityState={{ selected: fixture === index }} onPress={() => { chatScrollTrace.record("fixture.mode", "debug", { inverted, fixture: index }); setFixture(index); }} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 6 }}><Text style={[typography.caption, { color: fixture === index ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>)}
      </View>
      {Platform.OS === "android" ? <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, minHeight: 44, gap: 8 }}>
        <Text style={[typography.caption, { color: theme.colors.text, flex: 1 }]}>Focus scroll</Text>
        <Switch accessibilityLabel="Focus scroll in test list" value={focusScroll} onValueChange={(value) => {
          chatScrollTrace.record("fixture.focusScrollChange", "debug", { previous: focusScroll, scrollsChildToFocus: value, inverted, fixture, remount: true });
          setFocusScroll(value);
        }} />
      </View> : null}
      <ScrollFixture key={`${inverted}:${fixture}:${focusScroll}`} inverted={inverted} scrollsChildToFocus={focusScroll} message={messages[fixture]!} />
    </> : tab === "Chats" ? <FlatList data={state.sessions} keyExtractor={(item) => item.id} ListEmptyComponent={<Text style={[typography.body, { color: theme.colors.textMuted, padding: 16 }]}>No loaded chats</Text>} renderItem={({ item }) => <Pressable accessibilityRole="button" onPress={() => { chatScrollTrace.record("experiment.openChat", "debug", { session: chatScrollTrace.alias("session", item.id) }); router.push({ pathname: "/chat/[sessionId]", params: { sessionId: item.id } }); }} style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}><Text numberOfLines={2} style={[typography.body, { color: theme.colors.text }]}>{item.title || "Chat"}</Text></Pressable>} /> : <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
      {snapshot.entries.length === 0 ? <Text style={[typography.body, { color: theme.colors.textMuted }]}>No events</Text> : snapshot.entries.slice(-150).reverse().map((entry) => <View key={entry.sequence} style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingBottom: 8 }}>
        <Text selectable style={[typography.caption, { color: entry.event.startsWith("command.") ? theme.colors.accent : theme.colors.text }]}>{`#${entry.sequence} +${entry.elapsedMs}ms ${entry.source} ${entry.event}`}</Text>
        <Text selectable style={[typography.micro, { color: theme.colors.textMuted }]}>{JSON.stringify(entry.fields)}</Text>
      </View>)}
    </ScrollView>}
  </Screen>;
}

const ScrollFixture = memo(function ScrollFixture({ inverted, scrollsChildToFocus, message }: { inverted: boolean; scrollsChildToFocus: boolean; message: MessageRecord }) {
  const metrics = useRef({ y: 0, height: 0, viewport: 0 });
  const getState = useCallback(() => ({ inverted, scrollsChildToFocus, fixture: message.sequence, ...metrics.current }), [inverted, scrollsChildToFocus, message.sequence]);
  const { recording, log } = useChatScrollTrace("fixture", getState);
  const touches = useTraceTouches("fixture.list", getState, recording);
  return <FlatList {...touches} inverted={inverted} scrollsChildToFocus={scrollsChildToFocus} data={[message]} keyExtractor={(item) => item.id} renderItem={({ item }) => <MessageBubble message={item} />} keyboardShouldPersistTaps="handled" scrollEventThrottle={100} contentContainerStyle={{ paddingVertical: 12 }}
    onLayout={(event) => log("list.layout", { ...event.nativeEvent.layout })}
    onContentSizeChange={(width, height) => log("list.contentSize", { width, height })}
    onScroll={(event) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      log("list.scroll", { previousY: metrics.current.y, offsetY: contentOffset.y, deltaY: contentOffset.y - metrics.current.y, contentHeight: contentSize.height, viewportHeight: layoutMeasurement.height });
      metrics.current = { y: contentOffset.y, height: contentSize.height, viewport: layoutMeasurement.height };
    }}
    onScrollBeginDrag={() => log("list.dragBegin")}
    onScrollEndDrag={(event) => log("list.dragEnd", { offsetY: event.nativeEvent.contentOffset.y, velocityY: event.nativeEvent.velocity?.y })}
    onMomentumScrollBegin={() => log("list.momentumBegin")}
    onMomentumScrollEnd={(event) => log("list.momentumEnd", { offsetY: event.nativeEvent.contentOffset.y })}
  />;
});
