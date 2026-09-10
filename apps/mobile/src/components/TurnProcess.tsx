import type { CohubClient, ContentBlock, SessionTurnRecord } from "@neta-art/cohub";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { MessageContent } from "@/src/components/MessageContent";
import type { StreamView } from "@/src/data/types";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon } from "@/src/ui";

export function TurnProcess({ turn, client, spaceId }: { turn: SessionTurnRecord; client: CohubClient | null; spaceId: string }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; content: ContentBlock[] } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const objectKey = turn.intermediateIndex?.messagesObjectKey;
  const loadKey = `${turn.sessionId}:${turn.id}:${objectKey ?? ""}:${attempt}`;
  const content = loaded?.key === loadKey ? loaded.content : null;
  const errorMessage = expanded && objectKey && !client
    ? t("turn.connect")
    : error?.key === loadKey ? error.message : null;
  useEffect(() => {
    if (!expanded || !objectKey || !client) return;
    let active = true;
    const controller = new AbortController();
    const api = client.space(spaceId).session(turn.sessionId).turns.intermediate;
    void (async () => {
      const file = await api.get(turn.id, objectKey, { signal: controller.signal });
      const blocks = await Promise.all((file?.messages ?? []).map(async (message) => {
        const tools = message.toolCallsObjectKey ? await api.getToolCalls(turn.id, message, { signal: controller.signal }) : null;
        const body: ContentBlock[] = message.content.length ? message.content : message.text ? [{ type: "text", text: message.text }] : [];
        if (!tools) return body;
        return [...body.filter((block) => block.type !== "tool_use" && block.type !== "tool_result"), ...tools.toolCalls.flatMap((tool): ContentBlock[] => [
          { type: "tool_use", id: tool.id, name: tool.name, input: tool.input },
          ...(tool.result ? [{ type: "tool_result" as const, tool_use_id: tool.id, content: tool.result.content ?? "", is_error: tool.result.isError }] : []),
        ])];
      }));
      if (active) setLoaded({ key: loadKey, content: blocks.flat() });
    })().catch((cause: unknown) => { if (active) setError({ key: loadKey, message: cause instanceof Error ? cause.message : t("turn.loadError") }); });
    return () => { active = false; controller.abort(); };
  }, [client, expanded, loadKey, objectKey, spaceId, t, turn.id, turn.sessionId]);
  const summary = turn.intermediateSummary;
  if (!objectKey && !summary?.messageCount && !summary?.toolCallCount) return null;
  return <View style={{ marginHorizontal: 18, marginVertical: 6 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}>
      <AppIcon name={expanded ? "chevron-down" : "chevron-right"} size={16} />
      <Text style={[typography.caption, { color: theme.colors.textMuted, flex: 1 }]}>{summary ? t("turn.steps", { steps: summary.messageCount, tools: summary.toolCallCount }) : t("turn.executionDetails")}{turn.durationMs != null ? ` · ${Math.round(turn.durationMs / 1000)}s` : ""}</Text>
    </Pressable>
    {expanded ? <View style={{ borderLeftWidth: 1, borderLeftColor: theme.colors.border, paddingLeft: 12, gap: 8 }}>
      {errorMessage ? <Pressable accessibilityRole="button" onPress={() => setAttempt(attempt + 1)}><Text style={[typography.caption, { color: theme.colors.danger }]}>{errorMessage} {t("common.retry")}</Text></Pressable> : !objectKey ? <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{t("turn.notArchived")}</Text> : content === null ? <ActivityIndicator color={theme.colors.accent} /> : content.length ? <MessageContent content={content} /> : <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{t("turn.none")}</Text>}
    </View> : null}
  </View>;
}

export function StreamingTurnProcess({ messages }: { messages: StreamView["intermediateMessages"] }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (messages.length === 0) return null;
  const toolCount = messages.reduce((count, message) => count + message.content.filter((block) => block.type === "tool_use").length, 0);
  const content = messages.flatMap((message) => message.content.length ? message.content : message.text ? [{ type: "text" as const, text: message.text }] : []);
  return <View style={{ marginHorizontal: 18, marginVertical: 6 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}>
      <AppIcon name={expanded ? "chevron-down" : "chevron-right"} size={16} />
      <Text style={[typography.caption, { color: theme.colors.textMuted, flex: 1 }]}>{t("turn.steps", { steps: messages.length, tools: toolCount })}</Text>
    </Pressable>
    {expanded ? <View style={{ borderLeftWidth: 1, borderLeftColor: theme.colors.border, paddingLeft: 12, gap: 8 }}>
      {content.length ? <MessageContent content={content} /> : <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{t("turn.none")}</Text>}
    </View> : null}
  </View>;
}
