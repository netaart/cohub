import type { CohubClient, ContentBlock, SessionTurnRecord } from "@neta-art/cohub";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { MessageContent } from "@/src/components/MessageContent";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon } from "@/src/ui";

export function TurnProcess({ turn, client, spaceId }: { turn: SessionTurnRecord; client: CohubClient | null; spaceId: string }) {
  const theme = useAppTheme();
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<ContentBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const objectKey = turn.intermediateIndex?.messagesObjectKey;
  useEffect(() => {
    setContent(null);
    setError(null);
    if (!expanded || !objectKey) return;
    if (!client) { setError("Connect to Cohub to load execution details."); return; }
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
      if (active) setContent(blocks.flat());
    })().catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Unable to load execution details."); });
    return () => { active = false; controller.abort(); };
  }, [client, expanded, objectKey, spaceId, turn.id, turn.sessionId, attempt]);
  const summary = turn.intermediateSummary;
  if (!objectKey && !summary?.messageCount && !summary?.toolCallCount) return null;
  return <View style={{ marginHorizontal: 18, marginVertical: 6 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}>
      <AppIcon name={expanded ? "chevron-down" : "chevron-right"} size={16} />
      <Text style={[typography.caption, { color: theme.colors.textMuted, flex: 1 }]}>{summary ? `${summary.messageCount} steps · ${summary.toolCallCount} tools` : "Execution details"}{turn.durationMs != null ? ` · ${Math.round(turn.durationMs / 1000)}s` : ""}</Text>
    </Pressable>
    {expanded ? <View style={{ borderLeftWidth: 1, borderLeftColor: theme.colors.border, paddingLeft: 12, gap: 8 }}>
      {error ? <Pressable accessibilityRole="button" onPress={() => setAttempt(attempt + 1)}><Text style={[typography.caption, { color: theme.colors.danger }]}>{error} Retry</Text></Pressable> : !objectKey ? <Text style={[typography.caption, { color: theme.colors.textMuted }]}>Execution details were not archived.</Text> : content === null ? <ActivityIndicator color={theme.colors.accent} /> : content.length ? <MessageContent content={content} /> : <Text style={[typography.caption, { color: theme.colors.textMuted }]}>No execution details.</Text>}
    </View> : null}
  </View>;
}
