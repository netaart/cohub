import type { MessageRecord } from "@neta-art/cohub";
import { useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { MessageBubble } from "@/src/components/MessageContent";
import { typography, useAppTheme } from "@/src/theme";
import { Screen } from "@/src/ui";

const NOW = new Date().toISOString();
const SIZES = [500, 2000, 10000] as const;

function debugMessage(index: number): MessageRecord {
  const code = index % 7 === 0;
  const text = code
    ? `第 ${index} 条消息，带一段代码：\n\n\`\`\`ts\nexport function message${index}(value: string) {\n  return value.trim().toLowerCase();\n}\n\`\`\``
    : index % 3 === 0
      ? `第 ${index} 条消息，**加粗**、\`行内代码\`，以及一句稍微长一点的描述来模拟真实聊天内容。`
      : `第 ${index} 条消息。`;
  return {
    id: `debug-list-${index}`,
    sessionId: "debug-list",
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text }],
    text,
    sequence: index + 1,
    provider: index % 2 === 0 ? null : "cohub",
    model: index % 2 === 0 ? null : "debug-agent",
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

export default function DebugListScreen() {
  const theme = useAppTheme();
  const listRef = useRef<FlatList<MessageRecord>>(null);
  const [count, setCount] = useState<(typeof SIZES)[number]>(500);
  const messages = useMemo(() => Array.from({ length: count }, (_, index) => debugMessage(index)), [count]);

  return (
    <Screen>
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
        {SIZES.map((size) => (
          <Pressable key={size} accessibilityRole="tab" accessibilityState={{ selected: count === size }} onPress={() => setCount(size)} style={({ pressed }) => ({ minHeight: 32, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: count === size ? theme.colors.accentBorder : theme.colors.border, backgroundColor: count === size ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, justifyContent: "center" })}>
            <Text style={[typography.caption, { color: count === size ? theme.colors.accent : theme.colors.textMuted }]}>{size}</Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Scroll to latest" onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: false })} style={({ pressed }) => ({ minHeight: 32, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface, justifyContent: "center" })}>
          <Text style={[typography.caption, { color: theme.colors.textSecondary }]}>回到底部</Text>
        </Pressable>
      </View>
      <FlatList
        ref={listRef}
        inverted
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        initialNumToRender={16}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={32}
        windowSize={11}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingVertical: 12 }}
      />
    </Screen>
  );
}
