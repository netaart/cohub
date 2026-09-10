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

/** Larger corpus: same shapes repeated so high speeds still have parse work to do. */
const LONG_BODY = Array.from({ length: 12 }, (_, index) => `### 第 ${index + 1} 节\n\n${BODY}`).join("\n\n");

const TOOL_OUTPUT = [
  "> cohub-mobile@1.7.0 typecheck",
  "> tsc --noEmit --noUnusedLocals --noUnusedParameters",
  "",
  ...Array.from({ length: 24 }, (_, index) => `src/components/MessageContent.tsx(${60 + index},7): error TS2322: Type 'string' is not assignable to type 'ReactNode'.`),
  "",
  "Found 24 errors in 1 file.",
].join("\n");

const NOW = new Date().toISOString();
const SPEEDS = [1, 8, 64, 512, 4096, 32768] as const;
const FRAME_MS = 16;

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
  const [speedIndex, setSpeedIndex] = useState(1);
  const [tools, setTools] = useState(true);
  const [loop, setLoop] = useState(true);
  const [long, setLong] = useState(false);
  const speed = SPEEDS[speedIndex]!;
  const body = long ? LONG_BODY : BODY;
  const totalChars = INTRO.length + 2 + body.length;

  const messages = useMemo(() => [
    debugMessage("debug-user", "user", "帮我把 typecheck 修一下。"),
    debugMessage("debug-assistant", "assistant", "好的，我先跑一遍完整检查，再定位失败点。"),
  ], []);

  useEffect(() => {
    if (!started) return undefined;
    let raf: number | null = null;
    let lastTick = 0;
    const tick = (now: number) => {
      if (now - lastTick >= FRAME_MS) {
        lastTick = now;
        setVisible((current) => {
          const next = current + speed;
          if (next < totalChars) return next;
          return loop ? next % totalChars : totalChars;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [loop, speed, started, totalChars]);

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
    if (bodyVisible > 0) blocks.push({ type: "text", text: body.slice(0, bodyVisible) });
    return blocks;
  }, [body, tools, visible]);

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
        <ControlChip icon="refresh" label="重开" onPress={restart} />
        <ControlChip icon={started ? "stop" : "arrow-right"} label={started ? "暂停" : "继续"} onPress={() => setStarted((current) => !current)} />
        <ControlChip icon="zap" label={`${speed}字/帧`} onPress={() => setSpeedIndex((current) => (current + 1) % SPEEDS.length)} />
        <ControlChip icon={loop ? "sync" : "x"} label={loop ? "循环" : "单次"} onPress={() => setLoop((current) => !current)} />
        <ControlChip icon="file-text" label={long ? "长文" : "短文"} onPress={() => setLong((current) => !current)} />
        <ControlChip icon={tools ? "check" : "x"} label={tools ? "工具" : "无工具"} onPress={() => setTools((current) => !current)} />
      </View>
      <View style={[styles.metrics, { borderTopColor: theme.colors.border }]}>
        <Text style={[typography.micro, { color: theme.colors.textMuted, flex: 1 }]}>
          重渲染 {renders} · 已输出 {Math.min(visible, totalChars).toLocaleString()} / {totalChars.toLocaleString()} 字 · 约 {(speed * 1000 / FRAME_MS).toLocaleString()} 字/秒
        </Text>
      </View>
    </Screen>
  );
}

function ControlChip({ label, icon, onPress }: { label: string; icon?: IconName; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ minHeight: 32, paddingHorizontal: 9, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface, flexDirection: "row", alignItems: "center", gap: 4 })}>
      {icon ? <AppIcon name={icon} size={12} color={theme.colors.textMuted} /> : null}
      <Text style={[typography.micro, { color: theme.colors.textSecondary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = {
  controls: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: 6, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6, borderTopWidth: 1 },
  metrics: { paddingHorizontal: 12, paddingBottom: 8, borderTopWidth: 1 },
} satisfies Record<string, object>;
