import type { MessageRecord } from "@neta-art/cohub";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { MessageBubble } from "@/src/components/MessageContent";
import { typography, useAppTheme } from "@/src/theme";
import { AppIcon, Screen, type IconName } from "@/src/ui";

const NOW = new Date().toISOString();
/** Rolling mode keeps this many bubbles mounted, constantly replacing the oldest. */
const ROLL_WINDOW = 300;
/** Append mode auto-pauses at this size so the harness cannot OOM the device. */
const APPEND_CAP = 20_000;
const RATES = [1, 8, 32, 128, 512, 2048, 8192] as const;
const FPS_WINDOW_MS = 500;

type Mode = "roll" | "append";

/**
 * Markdown-heavy samples. Rendering a fake but realistic chat bubble is the
 * expensive path (parse + inline layout + custom blocks), so keep the shapes
 * varied enough that the harness measures the parser and the bubble, not an
 * empty string.
 */
const SAMPLES: string[] = [
  `第 {n} 条：**加粗**、*斜体*、\`行内代码\`、~~删除线~~ 和 [链接](https://example.com)。`,
  `## 第 {n} 条标题

- 无序列表项一
- 列表项二带 \`code\`
- 列表项三

1. 有序项一
2. 有序项二`,
  `> 第 {n} 条引用，测试左侧竖线和颜色。

普通段落收尾。`,
  `第 {n} 条代码块：

\`\`\`ts
export function message{n}(value: string) {
  return value.trim().toLowerCase();
}
\`\`\``,
  `第 {n} 条表格：

| 文件 | 错误数 | 状态 |
| --- | :---: | ---: |
| src/data/markdown.ts | 0 | 通过 |
| src/components/MessageContent.tsx | 2 | 待修 |`,
  `### 第 {n} 条三级标题

嵌套列表：

- 外层一
  - 内层 A
  - 内层 B
- 外层二`,
  `第 {n} 条超长不可断词：supercalifragilisticexpialidociousssssssssssssssssssssssssssssssssssss 后面继续一段普通文字。`,
  `第 {n} 条混合内容：先说 **重点**，再给 \`inline\`，然后

\`\`\`python
def greet(name: str) -> str:
    return f"hello {name}"
\`\`\`

最后引用：
> done`,
  `第 {n} 条：普通的一句话，模拟真实聊天里最常见的短消息。`,
  `第 {n} 条长段落：` +
    "这是一段刻意拉长的中文内容用来测试自动换行与行高计算。".repeat(6),
  `#### 第 {n} 条

1. 第一步
2. 第二步 \`run\`
3. 第三步
   - 子项
   - 子项`,
  `第 {n} 条组合：**标题式强调** + 列表 + 表格

| A | B |
| --- | --- |
| 1 | 2 |

- 收尾列表`,
];

function makeMessage(seq: number, text: string): MessageRecord {
  const assistant = seq % 2 === 1;
  return {
    id: `debug-bubble-${seq}`,
    sessionId: "debug-bubbles",
    role: assistant ? "assistant" : "user",
    content: [{ type: "text", text }],
    text,
    sequence: seq,
    provider: assistant ? "cohub" : null,
    model: assistant ? "debug-agent" : null,
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

export default function DebugBubblesScreen() {
  const theme = useAppTheme();
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<Mode>("roll");
  const [rateIndex, setRateIndex] = useState(3);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [fps, setFps] = useState(0);
  const rafRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const framesRef = useRef(0);
  const fpsWindowRef = useRef(0);
  const rate = RATES[rateIndex]!;

  const nextBatch = useCallback((count: number) => {
    const batch: MessageRecord[] = [];
    for (let index = 0; index < count; index += 1) {
      seqRef.current += 1;
      const seq = seqRef.current;
      const sample = SAMPLES[seq % SAMPLES.length]!;
      batch.push(makeMessage(seq, sample.replaceAll("{n}", String(seq))));
    }
    return batch;
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    fpsWindowRef.current = performance.now();
    framesRef.current = 0;

    const tick = (now: number) => {
      // Generate outside the state updater so StrictMode double-invocation cannot
      // duplicate sequence numbers or ids.
      const batch = nextBatch(rate);
      setMessages((previous) =>
        mode === "roll"
          ? [...batch, ...previous].slice(0, ROLL_WINDOW)
          : [...batch, ...previous],
      );
      framesRef.current += 1;
      const elapsed = now - fpsWindowRef.current;
      if (elapsed >= FPS_WINDOW_MS) {
        setFps(Math.round((framesRef.current * 1000) / elapsed));
        framesRef.current = 0;
        fpsWindowRef.current = now;
      }
      if (mode === "append" && seqRef.current >= APPEND_CAP) {
        setRunning(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [mode, nextBatch, rate, running]);

  const clear = useCallback(() => {
    setRunning(false);
    setMessages([]);
    seqRef.current = 0;
    framesRef.current = 0;
    setFps(0);
  }, []);

  return (
    <Screen>
      <FlatList
        inverted
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        initialNumToRender={12}
        maxToRenderPerBatch={16}
        updateCellsBatchingPeriod={16}
        windowSize={7}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingVertical: 12, flexGrow: messages.length === 0 ? 1 : undefined }}
        ListEmptyComponent={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><Text style={[typography.caption, { color: theme.colors.textMuted, textAlign: "center" }]}>点“开始”，用高速 Markdown 气泡压测渲染。</Text></View>}
      />
      <View style={[styles.controls, { borderTopColor: theme.colors.border, backgroundColor: theme.colors.background }]}>
        <ControlChip
          icon={running ? "stop" : "arrow-right"}
          label={running ? "暂停" : "开始"}
          tone={running ? "danger" : "accent"}
          onPress={() => setRunning((current) => !current)}
        />
        <ControlChip
          icon="sync"
          label={mode === "roll" ? "滚动" : "追加"}
          onPress={() => setMode((current) => current === "roll" ? "append" : "roll")}
        />
        <ControlChip
          icon="zap"
          label={`x${rate}`}
          onPress={() => setRateIndex((current) => (current + 1) % RATES.length)}
        />
        <ControlChip icon="trash" label="清空" onPress={clear} />
        <Text style={[typography.micro, { color: theme.colors.textMuted, flex: 1, textAlign: "right" }]}>
          列表 {messages.length} · FPS {fps}
        </Text>
      </View>
    </Screen>
  );
}

function ControlChip({ label, icon, onPress, tone = "default" }: { label: string; icon?: IconName; onPress: () => void; tone?: "default" | "accent" | "danger" }) {
  const theme = useAppTheme();
  const fg = tone === "accent" ? theme.colors.accent : tone === "danger" ? theme.colors.danger : theme.colors.textSecondary;
  const border = tone === "accent" ? theme.colors.accentBorder : tone === "danger" ? theme.colors.danger : theme.colors.border;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface, flexDirection: "row", alignItems: "center", gap: 5 })}>
      {icon ? <AppIcon name={icon} size={13} color={fg} /> : null}
      <Text style={[typography.caption, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = {
  controls: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1 },
} satisfies Record<string, object>;
