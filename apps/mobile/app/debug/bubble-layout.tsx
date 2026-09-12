import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FlatList, Image, Platform, Pressable, Switch, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageBubble, StreamCard, copyMessageText } from "@/src/components/MessageContent";
import { useToast } from "@/src/components/Toast";
import { bubbleFixtures, fixtureMessage } from "@/src/data/bubble-fixtures";
import { chatScrollTrace } from "@/src/data/chat-scroll-trace";
import { setFontScalePreference, setThemePreference, typography, useAppTheme, useFontScalePreference, type FontScalePreference } from "@/src/theme";
import { TopBar, IconButton, Screen } from "@/src/ui";

const STREAM_TEXT = "你好。\n\nThis reply grows from a short sentence into a longer paragraph, then finishes with a short final line.\n\n- First item\n- Second item\n\nDone.";
const GROUPS = ["Text", "Rich", "States", "Boundary", "Stream"] as const;
type Group = typeof GROUPS[number];

export default function BubbleLayoutDebugScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const textSize = useFontScalePreference();
  const [group, setGroup] = useState<Group>("Text");
  const [narrow, setNarrow] = useState(false);
  const [inverted, setInverted] = useState(false);
  const recording = useSyncExternalStore(chatScrollTrace.subscribe, chatScrollTrace.isRecording, chatScrollTrace.isRecording);
  const availableWidth = narrow ? Math.min(width, 280) : width;
  const fixtures = useMemo(() => bubbleFixtures(Image.resolveAssetSource(require("../../assets/images/icon.png")).uri), []);
  const selected = useMemo(() => fixtures.filter((fixture) => fixture.group === group), [fixtures, group]);
  const run = (action: Promise<unknown>) => void action.catch((error) => toast({ title: "Action failed", message: error instanceof Error ? error.message : "Unable to complete this action.", tone: "danger" }));
  const log = (event: string) => chatScrollTrace.record(event, "bubble.fixtures", { group, width: availableWidth, inverted, theme: theme.mode, textSize, fontScale });
  return <Screen contentStyle={{ paddingBottom: insets.bottom }}>
    <TopBar title="Bubble Layout" onBack={() => router.back()} actions={<>
      <IconButton name="bookmark" label="Mark layout experiment" disabled={!recording} onPress={() => log("experiment.mark")} />
      <IconButton name="copy" label="Copy layout log" onPress={() => { log("experiment.export"); chatScrollTrace.pause(); run(Clipboard.setStringAsync(chatScrollTrace.export()).then(() => toast({ title: "Layout log copied" }))); }} />
    </>} />
    <View style={{ paddingHorizontal: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border, gap: 4 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <Text style={[typography.caption, { color: theme.colors.text }]}>Record</Text>
        <Switch accessibilityLabel="Record bubble layout" value={recording} onValueChange={(enabled) => {
          if (enabled) chatScrollTrace.start({ platform: Platform.OS, osVersion: String(Platform.Version), width: availableWidth, fontScale, theme: theme.mode, textSize, experiment: "bubble-layout" });
          else chatScrollTrace.pause();
        }} />
        <Text style={[typography.caption, { color: theme.colors.text }]}>280 pt</Text>
        <Switch accessibilityLabel="Narrow viewport" value={narrow} onValueChange={(value) => { log("experiment.widthChange"); setNarrow(value); }} />
        <Text style={[typography.caption, { color: theme.colors.text }]}>Inverted</Text>
        <Switch accessibilityLabel="Inverted fixture list" value={inverted} onValueChange={(value) => { log("experiment.inversionChange"); setInverted(value); }} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <IconButton name={theme.mode === "dark" ? "sun" : "moon"} label="Toggle app theme" onPress={() => run(setThemePreference(theme.mode === "dark" ? "light" : "dark"))} />
        {(["small", "default", "large", "xlarge"] as FontScalePreference[]).map((value) => <Option key={value} label={value} selected={textSize === value} onPress={() => run(setFontScalePreference(value))} />)}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{GROUPS.map((value) => <Option key={value} label={value} selected={group === value} onPress={() => { log("experiment.groupChange"); setGroup(value); }} />)}</View>
    </View>
    {group === "Boundary" ? <FlatList key={`boundary:${inverted}`} inverted={inverted} data={Array.from({ length: 12 }, (_, index) => index)} keyExtractor={String} renderItem={({ item }) => <View style={{ width: availableWidth, alignSelf: "center", paddingVertical: 12, gap: 8 }}>
      <Text style={[typography.micro, { color: theme.colors.textMuted }]}>{`Boundary ${item + 1}`}</Text>
      {(["user", "assistant"] as const).map((role) => <MessageBubble key={role} availableWidth={availableWidth} message={fixtureMessage({ id: `boundary-${item}`, title: "Boundary", group: "Text", text: "测量文字".repeat(item + 1) }, role)} />)}
    </View>} /> : group === "Stream" ? <View style={{ width: availableWidth, alignSelf: "center", flex: 1 }}><StreamingFixture availableWidth={availableWidth} inverted={inverted} /></View> : <FlatList
      key={`${group}:${inverted}`} inverted={inverted} data={selected} keyExtractor={(fixture) => fixture.id}
      keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: 12 }}
      renderItem={({ item }) => <View style={{ width: availableWidth, alignSelf: "center", marginBottom: 18 }}>
        <Text style={[typography.micro, { color: theme.colors.textMuted, paddingHorizontal: 12, marginBottom: 6 }]}>{item.title}</Text>
        {(["user", "assistant"] as const).map((role) => <MessageBubble key={role} message={fixtureMessage(item, role)} local={item.local} availableWidth={availableWidth} onCopy={(text) => run(copyMessageText(text))} />)}
      </View>}
    />}
  </Screen>;
}

function Option({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable accessibilityRole="tab" accessibilityState={{ selected }} onPress={onPress} style={{ minHeight: 44, justifyContent: "center", borderBottomWidth: 2, borderBottomColor: selected ? theme.colors.accent : "transparent", paddingHorizontal: 4 }}><Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
}

function StreamingFixture({ availableWidth, inverted }: { availableWidth: number; inverted: boolean }) {
  const [visible, setVisible] = useState(0);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!running || visible >= STREAM_TEXT.length) return;
    const timer = setTimeout(() => setVisible((value) => Math.min(STREAM_TEXT.length, value + 6)), 90);
    return () => clearTimeout(timer);
  }, [running, visible]);
  const completed = visible === STREAM_TEXT.length;
  return <>
    <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 12 }}>
      <IconButton name={running ? "stop" : "arrow-right"} label={running ? "Pause stream" : "Start stream"} onPress={() => { setFailed(false); setRunning(!running); }} />
      <IconButton name="refresh" label="Restart stream" onPress={() => { setFailed(false); setVisible(0); setRunning(true); }} />
      <IconButton name="alert" label="Interrupt stream" onPress={() => { setRunning(false); setFailed(true); }} />
    </View>
    <FlatList inverted={inverted} data={inverted ? ["sample", "pending"] : ["pending", "sample"]} keyExtractor={(value) => value} renderItem={({ item }) => item === "pending" ? <StreamCard content={[]} status="pending" availableWidth={availableWidth} /> : completed && !failed ? <MessageBubble availableWidth={availableWidth} message={fixtureMessage({ id: "stream-final", title: "Final", group: "States", text: STREAM_TEXT }, "assistant")} /> : <StreamCard availableWidth={availableWidth} content={visible > 0 ? [{ type: "text", text: STREAM_TEXT.slice(0, visible) }] : []} status={failed ? "interrupted" : "streaming"} />} />
  </>;
}
