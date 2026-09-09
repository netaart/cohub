import type { ContentBlock, MessageRecord } from "@neta-art/cohub";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { MessageBubble, StreamCard } from "@/src/components/MessageContent";
import { typography, useAppTheme } from "@/src/theme";
import { AppIcon, Screen, type IconName } from "@/src/ui";

const INTRO = "先确认一下当前改动，再决定从哪里开始修。";
const BODY = `## 发现的问题

类型错误来自 **三个地方**，其中只有一个是真实缺陷：

\`\`\`ts
type Result = { ok: true } | { ok: false; error: string };
export function unwrap(result: Result) {
  return result.ok ? result : result.error;
}
\`\`\`

| 文件 | 错误数 |
| --- | --- |
| src/data/markdown.ts | 0 |
| src/components/MessageContent.tsx | 2 |

- 每次 patch 都会重新解析整段 Markdown
- 只有正在增长的那一块应该重渲染

下面开始修这两个类型错误。`;
const TOOL_OUTPUT = [
  "> cohub-mobile@1.7.0 typecheck",
  "> tsc --noEmit --noUnusedLocals --noUnusedParameters",
  "",
  ...Array.from({ length: 24 }, (_, index) => `src/components/MessageContent.tsx(${60 + index},7): error TS2322: Type 'string' is not assignable to type 'ReactNode'.`),
  "",
  "Found 24 errors in 1 file.",
].join("\n");

const NOW = new Date().toISOString();

function debugMessage(id: string, role: "user" | "assistant", text: string): MessageRecord {
  return {
    id,
    sessionId: "debug-streaming",
    role,
    content: [{ type: "text", text }],
    text,
    sequence: role === "user" ? 1 : 2,
    provider: role === "assistant" ? "cohub" : null,
    model: role === "assistant" ? "debug-agent" : null,
    stopReason: "stop",
    errorMessage: null,
    usage: null,
    meta: null,
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 0,
    createdAt: NOW,
  } as MessageRecord;
}

function RenderProbe({ onRender }: { onRender: () => void }) {
  useEffect(() => {
    onRender();
  });
  return null;
}

export default function DebugStreamingScreen() {
  const theme = useAppTheme();
  const listRef = useRef<FlatList<MessageRecord>>(null);
  const followingRef = useRef(true);
  const renderCountRef = useRef(0);
  const [following, setFollowing] = useState(true);
  const [renders, setRenders] = useState(0);
  const [visible, setVisible] = useState(0);
  const [started, setStarted] = useState(true);
  const [speed, setSpeed] = useState(2);
  const [tools, setTools] = useState(true);
  const totalChars = INTRO.length + 2 + BODY.length;

  const messages = useMemo(() => [
    debugMessage("debug-user", "user", "帮我把 typecheck 修一下。"),
    debugMessage("debug-assistant", "assistant", "好的，我先跑一遍完整检查，再定位失败点。"),
  ], []);

  useEffect(() => {
    if (!started) return;
    const timer = setInterval(() => {
      setVisible((current) => Math.min(totalChars, current + speed));
    }, 32);
    return () => clearInterval(timer);
  }, [started, speed, totalChars]);

  useEffect(() => {
    const timer = setInterval(() => setRenders(renderCountRef.current), 250);
    return () => clearInterval(timer);
  }, []);

  const content = useMemo<ContentBlock[]>(() => {
    const intro = INTRO.slice(0, Math.min(visible, INTRO.length));
    const bodyVisible = Math.max(0, visible - INTRO.length - 2);
    const blocks: ContentBlock[] = [{ type: "text", text: intro }];
    if (tools && visible >= INTRO.length + 2) {
      blocks.push({ type: "tool_use", id: "debug-tool", name: "terminal", input: { command: "npm run typecheck" } });
      if (bodyVisible > 0) {
        blocks.push({ type: "tool_result", tool_use_id: "debug-tool", content: TOOL_OUTPUT, is_error: false });
      }
    }
    if (bodyVisible > 0) blocks.push({ type: "text", text: BODY.slice(0, bodyVisible) });
    return blocks;
  }, [tools, visible]);

  const restart = useCallback(() => {
    renderCountRef.current = 0;
    setRenders(0);
    setVisible(0);
    setStarted(true);
  }, []);

  const markRender = useCallback(() => {
    renderCountRef.current += 1;
  }, []);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y <= 60;
    if (next === followingRef.current) return;
    followingRef.current = next;
    setFollowing(next);
  }, []);

  const handleContentSizeChange = useCallback(() => {
    if (followingRef.current) listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  return (
    <Screen>
      <RenderProbe onRender={markRender} />
      <FlatList
        ref={listRef}
        inverted
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        maintainVisibleContentPosition={following ? undefined : { minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        onContentSizeChange={handleContentSizeChange}
        contentContainerStyle={{ paddingVertical: 12, flexGrow: 1, justifyContent: "flex-end" }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={<StreamCard content={content} status="streaming" />}
      />
      <View style={[styles.controls, { borderTopColor: theme.colors.border, backgroundColor: theme.colors.background }]}>
        <ControlChip icon="refresh" label="重新开始" onPress={restart} />
        <ControlChip icon={started ? "stop" : "arrow-right"} label={started ? "暂停" : "继续"} onPress={() => setStarted((current) => !current)} />
        <ControlChip label={`${speed}x`} onPress={() => setSpeed((current) => current >= 8 ? 1 : current * 2)} />
        <ControlChip icon={tools ? "check" : "x"} label={tools ? "工具开" : "工具关"} onPress={() => setTools((current) => !current)} />
        <Text style={[typography.micro, { color: theme.colors.textMuted, flex: 1, textAlign: "right" }]}>
          重渲染 {renders}
        </Text>
      </View>
    </Screen>
  );
}

function ControlChip({ label, icon, onPress }: { label: string; icon?: IconName; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface, flexDirection: "row", alignItems: "center", gap: 5 })}>
      {icon ? <AppIcon name={icon} size={13} color={theme.colors.textMuted} /> : null}
      <Text style={[typography.caption, { color: theme.colors.textSecondary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = {
  controls: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1 },
} satisfies Record<string, object>;
