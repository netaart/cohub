import type { ContentBlock, MessageRecord } from "@neta-art/cohub";
import { Image, Text, View } from "react-native";
import { AppIcon } from "@/src/ui";
import { useAppTheme, typography } from "@/src/theme";
import { contentBlockText } from "@/src/utils";

function TextBlock({ value, muted = false }: { value: string; muted?: boolean }) {
  const theme = useAppTheme();
  const chunks = value.split("```");
  return <View style={{ gap: 9 }}>{chunks.map((chunk, index) => {
    if (index % 2 === 1) return <View key={`${index}-${chunk.slice(0, 8)}`} style={{ backgroundColor: theme.colors.background, borderRadius: 10, padding: 11, borderWidth: 1, borderColor: theme.colors.border }}><Text selectable style={{ color: theme.colors.textSecondary, fontFamily: "SpaceMono", fontSize: 12, lineHeight: 18 }}>{chunk.trim()}</Text></View>;
    return chunk.trim() ? <Text key={`${index}-${chunk.slice(0, 8)}`} selectable style={[typography.body, { color: muted ? theme.colors.textMuted : theme.colors.text, lineHeight: 23 }]}>{chunk.trim()}</Text> : null;
  })}</View>;
}

function Block({ block }: { block: ContentBlock }) {
  const theme = useAppTheme();
  if (block.type === "text") return <TextBlock value={block.text} />;
  if (block.type === "thinking") return <TextBlock value={block.thinking} muted />;
  if (block.type === "image" && block.source?.type === "url") {
    return <Image source={{ uri: block.source.url }} resizeMode="contain" style={{ width: "100%", height: 220, borderRadius: 12, backgroundColor: theme.colors.surfaceRaised }} />;
  }
  if (block.type === "tool_use") {
    return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 }}><AppIcon name="terminal" size={15} color={theme.colors.info} /><Text style={[typography.caption, { color: theme.colors.info }]}>{block.name || "Using a tool"}</Text></View>;
  }
  if (block.type === "tool_result") {
    return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7 }}><AppIcon name="check-circle" size={15} color={theme.colors.success} /><Text style={[typography.caption, { color: theme.colors.textMuted }]}>{contentBlockText(block)}</Text></View>;
  }
  return null;
}

export function MessageContent({ content }: { content: ContentBlock[] | null | undefined }) {
  return <View style={{ gap: 6 }}>{(content ?? []).map((block, index) => <Block key={`${block.type}-${index}`} block={block} />)}</View>;
}

export function MessageBubble({ message, local = false }: { message: MessageRecord; local?: boolean }) {
  const theme = useAppTheme();
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  if (isSystem) return <View style={{ alignItems: "center", paddingHorizontal: 24, paddingVertical: 8 }}><Text style={[typography.caption, { color: theme.colors.textFaint, textAlign: "center" }]}>{message.text || "System update"}</Text></View>;
  return <View style={{ paddingHorizontal: 16, paddingVertical: 7, alignItems: isUser ? "flex-end" : "stretch" }}>
    {!isUser ? <Text style={[typography.micro, { color: theme.colors.textMuted, marginBottom: 5, marginLeft: 2 }]}>{message.provider || "Agent"}{message.model ? ` · ${message.model}` : ""}</Text> : null}
    <View style={{ maxWidth: isUser ? "86%" : "100%", borderRadius: isUser ? 17 : 13, borderTopRightRadius: isUser ? 5 : 13, backgroundColor: isUser ? theme.colors.accentSoft : theme.colors.surface, borderWidth: 1, borderColor: isUser ? theme.colors.accentBorder : theme.colors.border, paddingHorizontal: 13, paddingVertical: 11, opacity: local ? 0.72 : 1 }}>
      <MessageContent content={message.content} />
      {local ? <Text style={[typography.micro, { color: theme.colors.textMuted, marginTop: 7 }]}>Sending…</Text> : null}
      {message.errorMessage ? <Text style={[typography.caption, { color: theme.colors.danger, marginTop: 7 }]}>{message.errorMessage}</Text> : null}
    </View>
  </View>;
}

export function StreamCard({ content, status }: { content: ContentBlock[]; status: string }) {
  const theme = useAppTheme();
  return <View style={{ marginHorizontal: 16, marginVertical: 9, borderRadius: 13, borderWidth: 1, borderColor: theme.colors.info, backgroundColor: theme.colors.infoSoft, padding: 13 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.info }} /><Text style={[typography.caption, { color: theme.colors.info }]}>{status === "pending" ? "Starting" : "Agent is working"}</Text></View><MessageContent content={content} /></View>;
}
