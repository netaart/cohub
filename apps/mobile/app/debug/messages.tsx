import type { ContentBlock, MessageRecord } from "@neta-art/cohub";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { MessageBubble } from "@/src/components/MessageContent";
import { compactionFromMessage } from "@/src/data/compaction";
import { useApp } from "@/src/data/context";
import { mergeDisplayMessages, messagesFromTurns } from "@/src/data/session-history";
import { typography, useAppTheme } from "@/src/theme";
import { hasRenderableMessage, isAssistantIntermediate } from "@/src/utils";
import { Screen, SectionHeader } from "@/src/ui";

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function blockSummary(block: ContentBlock): string {
  if (block.type === "text") return `text:${block.text.length}`;
  if (block.type === "thinking") return `thinking:${block.thinking.length}`;
  if (block.type === "tool_use") return `tool_use:${block.name}`;
  if (block.type === "tool_result") return "tool_result";
  if (block.type === "image") return "image";
  if (block.type === "shell_command") return `shell:${block.command.length}`;
  return `note:${block.note_type}`;
}

function contentSummary(content: ContentBlock[] | null | undefined): string {
  if (content == null) return "null";
  if (!Array.isArray(content)) return typeof content;
  if (content.length === 0) return "[]";
  return `[${content.map(blockSummary).join(", ")}]`;
}

const CONTROL_MESSAGE: MessageRecord = {
  id: "debug-usage-control",
  sessionId: "debug-usage",
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "对照组：合成消息（usage.output = 1160，footer 应显示 ↓1.2K）。" }],
  text: "对照组：合成消息（usage.output = 1160，footer 应显示 ↓1.2K）。",
  sequence: -1,
  provider: "cohub",
  model: "deepseek-flash",
  stopReason: "stop",
  errorMessage: null,
  usage: { input: 1000, output: 1160, cacheRead: 253184, cacheWrite: 0, totalTokens: 255344 },
  meta: { messageKind: "assistant_final", turnId: "debug-control", requestedThinkingLevel: "xhigh" },
  authorUuid: null,
  authorProfile: null,
  startedAt: null,
  completedAt: null,
  durationMs: 0,
  createdAt: new Date().toISOString(),
};

/**
 * Renders the exact assistant messages the chat timeline would show, with the
 * raw `usage` payload next to the real bubble footer. Used to tell apart
 * "usage missing on the message" from "footer failed to render it".
 */
export default function DebugMessagesScreen() {
  const theme = useAppTheme();
  const { state } = useApp();
  const loaded = useMemo(
    () => state.sessions.filter((session) => state.sessionViews[session.id]),
    [state.sessions, state.sessionViews],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sessionId = selectedId ?? loaded[0]?.id ?? null;
  const view = sessionId ? state.sessionViews[sessionId] : null;

  const messages = useMemo(() => {
    if (!view) return [];
    const history = messagesFromTurns(view.turns);
    return mergeDisplayMessages(
      history.length > 0 ? history : view.messages,
      history.length > 0 ? view.messages : [],
    )
      .filter((message) => !isAssistantIntermediate(message) && hasRenderableMessage(message))
      .sort((a, b) => a.sequence - b.sequence);
  }, [view]);

  const assistantMessages = messages.filter((message) => message.role === "assistant").slice(-8);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <SectionHeader title="已加载的对话" />
        <View style={{ paddingHorizontal: 16, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {loaded.slice(0, 6).map((session) => (
            <Pressable
              key={session.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: session.id === sessionId }}
              onPress={() => setSelectedId(session.id)}
              style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 13, borderRadius: 999, justifyContent: "center", borderWidth: 1, borderColor: session.id === sessionId ? theme.colors.accentBorder : theme.colors.border, backgroundColor: session.id === sessionId ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface })}
            >
              <Text numberOfLines={1} style={[typography.caption, { color: session.id === sessionId ? theme.colors.accent : theme.colors.textMuted, maxWidth: 220 }]}>{session.title?.trim() || session.id.slice(0, 8)}</Text>
            </Pressable>
          ))}
          {loaded.length === 0 ? (
            <Text style={[typography.caption, { color: theme.colors.textMuted }]}>没有已加载的对话：先打开一个对话，再回到这里。</Text>
          ) : null}
        </View>

        {view ? <>
          <SectionHeader title="状态" />
          <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
            <Row label="historyLoaded" value={String(view.historyLoaded)} />
            <Row label="turns / messages" value={`${view.turns.length} / ${view.messages.length}`} />
            <Row label="stream" value={view.stream ? `${view.stream.status}${view.stream.turnId ? ` · ${view.stream.turnId.slice(0, 8)}` : ""}` : "—"} />
          </View>

          <SectionHeader title="对照组（合成消息）" />
          <Text selectable style={[typography.caption, { color: theme.colors.textMuted, marginHorizontal: 16, marginBottom: 4 }]}>
            固定 usage.output=1160；气泡 footer 应显示 ↓1.2K。
          </Text>
          <View style={{ marginHorizontal: 16, borderWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border }}>
            <MessageBubble message={CONTROL_MESSAGE} />
          </View>

          <SectionHeader title="最近的 assistant 消息（usage + 真实渲染）" />
          {assistantMessages.length === 0 ? (
            <Text style={[typography.caption, { color: theme.colors.textMuted, marginHorizontal: 16 }]}>没有 assistant 消息。</Text>
          ) : assistantMessages.map((message) => {
            const usage = message.usage;
            const inputValue = (usage?.input ?? 0) + (usage?.cacheRead ?? 0);
            const cached = typeof usage?.cacheRead === "number" && usage.cacheRead > 0 ? formatTokenCount(usage.cacheRead) : null;
            const input = inputValue > 0 ? formatTokenCount(inputValue) : null;
            const output = typeof usage?.output === "number" && usage.output > 0 ? formatTokenCount(usage.output) : null;
            return <View key={message.id} style={{ marginTop: 12 }}>
              <Text selectable style={[typography.micro, { color: theme.colors.textFaint, marginHorizontal: 16 }]}>{`#${message.sequence} · ${String(message.meta?.messageKind ?? "?")} · ${message.model ?? "—"}`}</Text>
              <Text selectable style={[typography.code, { color: theme.colors.textSecondary, marginHorizontal: 16, marginTop: 4 }]}>{usage ? JSON.stringify(usage) : "usage: null"}</Text>
              <Text selectable style={[typography.code, { color: theme.colors.textMuted, marginHorizontal: 16, marginTop: 3 }]}>
                {`live=${message.meta?._mobileLive === true ? "y" : "n"} text=${message.text == null ? "null" : `${message.text.length}c`} content=${contentSummary(message.content)} notice=${compactionFromMessage(message) ? "y" : "n"} render=${hasRenderableMessage(message) ? "y" : "n"}`}
              </Text>
              <Text selectable style={[typography.code, { color: theme.colors.textFaint, marginHorizontal: 16, marginTop: 3 }]}>
                {`keys: ${Object.keys(message).join(",")}${message.meta ? ` · meta: ${Object.keys(message.meta).join(",")}` : ""}`}
              </Text>
              <Text selectable style={[typography.caption, { color: output ? theme.colors.success : theme.colors.danger, marginHorizontal: 16, marginTop: 3 }]}>
                {`tokens → input ${input ?? "—"} / cached ${cached ?? "—"} / output ${output ? `↓${output}` : "MISSING"}`}
              </Text>
              <Text selectable style={[typography.micro, { color: theme.colors.textFaint, marginHorizontal: 16, marginTop: 6 }]}>气泡 ↓（虚线框内）</Text>
              <View style={{ marginHorizontal: 16, marginTop: 2, borderWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border }}>
                <MessageBubble message={message} />
              </View>
            </View>;
          })}
        </> : null}
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const theme = useAppTheme();
  return (
    <View style={{ minHeight: 50, paddingHorizontal: 13, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <Text style={[typography.caption, { color: theme.colors.textMuted, width: 128 }]}>{label}</Text>
      <Text selectable style={[typography.caption, { color: theme.colors.text, flex: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

const styles = {
  group: { marginHorizontal: 16, borderWidth: 1, borderRadius: 14, overflow: "hidden" as const },
} satisfies Record<string, object>;
