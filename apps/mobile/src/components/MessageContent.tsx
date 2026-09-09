import type { ContentBlock, MessageRecord } from "@neta-art/cohub";
import * as Haptics from "expo-haptics";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Image, Linking, Platform, Pressable, ScrollView, Share, Text, View, useWindowDimensions, type GestureResponderEvent, type ViewStyle } from "react-native";
import { CodeBlock } from "@/src/components/CodeBlock";
import { useRevealedStreamText } from "@/src/components/useRevealedStreamText";
import { formatMessageClock } from "@/src/data/chat-format";
import { markdownBlockSignature, parseMarkdown, type MarkdownBlock, type MarkdownInline, type MarkdownTableAlignment } from "@/src/data/markdown";
import { formatToolCallCaption, toolCallPreview } from "@/src/data/tool-call";
import type { StreamView } from "@/src/data/types";
import { formatThinkingLevel, requestedThinkingLevel } from "@/src/model-catalog";
import { scaleFontSize, scaleLineHeight, useAppTheme, typography, type AppTheme } from "@/src/theme";
import { AppIcon, type IconName } from "@/src/ui";
import { contentText, hasRenderableContent, hasRenderableMessage, messageText } from "@/src/utils";

function InlineNodes({ nodes, accent, color }: { nodes: MarkdownInline[]; accent: string; color: string }) {
  const theme = useAppTheme();
  return <>{nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type === "code") {
      return <Text key={`code-${index}`} style={{ fontFamily: "SpaceMono", fontSize: Math.max(11, typography.chatBody.fontSize - 2), color, backgroundColor: theme.colors.surfaceRaised, borderRadius: 4, paddingHorizontal: 4 }}>{node.value}</Text>;
    }
    if (node.type === "link") {
      return <Text key={`link-${index}`} style={{ color: accent, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(node.url).catch(() => undefined)}>{node.value}</Text>;
    }
    return <Text key={`${node.type}-${index}`} style={node.type === "strong" ? { fontWeight: "700" } : { fontStyle: "italic" }}>{node.value}</Text>;
  })}</>;
}

function MarkdownTable({ alignments, header, rows, accent, textColor }: { alignments: MarkdownTableAlignment[]; header: MarkdownInline[][]; rows: MarkdownInline[][][]; accent: string; textColor: string }) {
  const theme = useAppTheme();
  const [viewportWidth, setViewportWidth] = useState(0);
  const columnCount = Math.max(header.length, alignments.length, ...rows.map((row) => row.length), 1);
  // Keep the table inside the message width. A nested horizontal scroller is
  // unreliable inside the inverted chat list on Android.
  return <View onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}>
    <View style={{ width: viewportWidth || "100%", borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: "hidden" }}>
      {[header, ...rows].map((row, rowIndex) => (
        <View key={rowIndex} style={{ flexDirection: "row", backgroundColor: rowIndex === 0 ? theme.colors.surfaceRaised : "transparent" }}>
          {Array.from({ length: columnCount }, (_, cellIndex) => row[cellIndex] ?? []).map((cell, cellIndex) => (
            <View key={cellIndex} style={{ flex: 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 7, borderTopWidth: rowIndex === 0 ? 0 : 1, borderLeftWidth: cellIndex === 0 ? 0 : 1, borderColor: theme.colors.border }}>
              <Text style={[typography.chatBody, { color: textColor, fontWeight: rowIndex === 0 ? "600" : "400", textAlign: alignments[cellIndex] ?? "left" }]}>
                <InlineNodes nodes={cell} accent={accent} color={textColor} />
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  </View>;
}

function MarkdownBlockView({ block, accent, textColor }: { block: MarkdownBlock; accent: string; textColor: string }) {
  const theme = useAppTheme();
  if (block.type === "code") return <CodeBlock code={block.code} language={block.language} streaming={!block.closed} />;
  if (block.type === "table") return <MarkdownTable alignments={block.alignments} header={block.header} rows={block.rows} accent={accent} textColor={textColor} />;
  if (block.type === "heading") {
    const size = scaleFontSize(block.level <= 2 ? 19 : block.level <= 4 ? 17 : 15);
    return <Text style={{ color: textColor, fontSize: size, lineHeight: size + 6, fontWeight: "700", marginTop: 3 }}><InlineNodes nodes={block.inlines} accent={accent} color={textColor} /></Text>;
  }
  if (block.type === "quote") {
    return <View style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.accentBorder, paddingLeft: 10 }}><Text style={[typography.chatBody, { color: theme.colors.textMuted }]}><InlineNodes nodes={block.inlines} accent={accent} color={theme.colors.textMuted} /></Text></View>;
  }
  if (block.type === "list") {
    return <View style={{ gap: 6 }}>{block.items.map((item, index) => <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}><Text style={[typography.chatBody, { color: accent, minWidth: 18 }]}>{block.ordered ? `${block.start + index}.` : "•"}</Text><Text style={[typography.chatBody, { color: textColor, flex: 1 }]}><InlineNodes nodes={item} accent={accent} color={textColor} /></Text></View>)}</View>;
  }
  return <Text style={[typography.chatBody, { color: textColor }]}><InlineNodes nodes={block.inlines} accent={accent} color={textColor} /></Text>;
}

// Every stream patch re-parses the whole message; memoizing per block keeps
// completed blocks from re-rendering and leaves only the growing block live.
const MemoBlock = memo(
  function MemoBlock(props: { block: MarkdownBlock; signature: string; accent: string; textColor: string }) {
    return <MarkdownBlockView block={props.block} accent={props.accent} textColor={props.textColor} />;
  },
  (previous, next) => previous.signature === next.signature && previous.accent === next.accent && previous.textColor === next.textColor,
);

const MarkdownBody = memo(function MarkdownBody({ source, accent, textColor }: { source: string; accent: string; textColor: string }) {
  const entries = useMemo(() => parseMarkdown(source).map((block) => ({ block, signature: markdownBlockSignature(block) })), [source]);
  return <>{entries.map((entry, index) => <MemoBlock key={index} block={entry.block} signature={entry.signature} accent={accent} textColor={textColor} />)}</>;
});

function TextBlock({ value, muted = false, accent, color, streaming = false }: { value: string; muted?: boolean; accent: string; color?: string; streaming?: boolean }) {
  const theme = useAppTheme();
  const textColor = muted ? theme.colors.textMuted : (color ?? theme.colors.text);
  const displayed = useRevealedStreamText(value, streaming);
  return <View style={{ gap: 9, width: "100%", minWidth: 0 }}><MarkdownBody source={displayed} accent={accent} textColor={textColor} /></View>;
}

function Block({ block, color, streaming = false }: { block: ContentBlock; color?: string; streaming?: boolean }) {
  const theme = useAppTheme();
  const accent = color ?? theme.colors.accent;
  if (block.type === "text") return <TextBlock value={block.text} accent={accent} color={color} streaming={streaming} />;
  if (block.type === "thinking") return <TextBlock value={block.thinking} muted accent={accent} streaming={streaming} />;
  if (block.type === "image") {
    const uri = block.source?.type === "url"
      ? block.source.url
      : block.source?.type === "base64"
        ? `data:${block.source.media_type};base64,${block.source.data}`
        : null;
    if (!uri) return null;
    return <Image source={{ uri }} resizeMode="contain" style={{ width: "100%", height: 220, borderRadius: 12, backgroundColor: theme.colors.surfaceRaised }} />;
  }
  return null;
}

function toolIcon(name: string): IconName {
  const key = name.toLowerCase();
  if (key.includes("skill")) return "book-open";
  if (key.includes("bash") || key.includes("terminal") || key.includes("shell") || key.includes("command")) return "terminal";
  if (key.includes("write") || key.includes("edit") || key.includes("patch")) return "square-pen";
  if (key.includes("read") || key.includes("file")) return "file-text";
  if (key.includes("grep") || key.includes("find") || key.includes("search") || key.includes("glob")) return "search";
  if (key === "ls" || key.includes("list") || key.includes("folder")) return "folder";
  if (key.includes("web") || key.includes("fetch") || key.includes("http")) return "globe";
  if (key.includes("think")) return "brain";
  return "code";
}

// Long tool bodies are height-capped and scroll internally. The cap is applied via
// ScrollView only once the content actually overflows it: inside the inverted chat
// list (scale(-1) cells on Android) a nested scroller measures at its full
// maxHeight and leaves a blank gap under short content.
const TOOL_OUTPUT_MAX_HEIGHT = 220;

function CappedCodeText({ value, color }: { value: string; color: string }) {
  const [overflows, setOverflows] = useState(false);
  const text = value || "(empty output)";
  const textStyle = [typography.code, { fontFamily: "SpaceMono", color }];
  if (overflows) {
    return (
      <ScrollView nestedScrollEnabled style={{ maxHeight: TOOL_OUTPUT_MAX_HEIGHT }}>
        <Text style={textStyle}>{text}</Text>
      </ScrollView>
    );
  }
  return (
    <Text
      onLayout={(event) => {
        const height = event.nativeEvent.layout.height;
        if (height > TOOL_OUTPUT_MAX_HEIGHT) setOverflows(true);
      }}
      style={textStyle}
    >
      {text}
    </Text>
  );
}

function ToolOutput({ block }: { block: Extract<ContentBlock, { type: "tool_result" }> }) {
  const theme = useAppTheme();
  // Running tools keep appending to `content`; the body must be height-capped
  // (mirroring the web's tail view) or an expanded bubble grows forever.
  return <View style={{ gap: 6 }}><Text style={[typography.micro, { color: block.is_error ? theme.colors.danger : theme.colors.textMuted }]}>OUT{block.is_error ? " · Error" : ""}</Text>{typeof block.content === "string" ? <CappedCodeText value={block.content} color={theme.colors.text} /> : <MessageContent content={block.content} />}</View>;
}

function ToolCall({ block, result, active = false }: { block: Extract<ContentBlock, { type: "tool_use" }>; result?: Extract<ContentBlock, { type: "tool_result" }>; active?: boolean }) {
  const theme = useAppTheme();
  const [expanded, setExpanded] = useState(false);
  const status = result ? result.is_error ? "error" : "done" : active ? "running" : "no result";
  const iconColor = result?.is_error ? theme.colors.danger : active && !result ? theme.colors.accent : theme.colors.textMuted;
  const preview = toolCallPreview(block.name, block.input);
  const caption = formatToolCallCaption(block.name, block.input);
  const edits = Array.isArray(block.input.edits) ? block.input.edits.filter((edit): edit is { oldText: string; newText: string } => typeof edit === "object" && edit !== null && typeof edit.oldText === "string" && typeof edit.newText === "string") : [];
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${caption}: ${status}`} accessibilityState={{ expanded }} hitSlop={8} onPress={() => setExpanded(!expanded)} style={{ minHeight: 22, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}>
      <AppIcon name={toolIcon(block.name)} size={14} color={iconColor} />
      <Text numberOfLines={1} style={{ flex: 1, fontSize: scaleFontSize(13), lineHeight: scaleLineHeight(18) }}>
        <Text style={{ color: theme.colors.text, fontWeight: "500" }}>{block.name}</Text>
        {preview ? <Text style={{ color: theme.colors.textMuted }}>{`: "${preview}"`}</Text> : null}
      </Text>
    </Pressable>
    {expanded ? <View style={{ borderLeftWidth: 1, borderLeftColor: theme.colors.border, paddingLeft: 12, gap: 8, marginTop: 4 }}>
      <Text style={[typography.micro, { color: theme.colors.textMuted }]}>IN</Text>
      <CappedCodeText value={JSON.stringify(block.input, null, 2)} color={theme.colors.text} />
      {edits.map((edit, index) => <View key={index}><Text style={[typography.code, { fontFamily: "SpaceMono", color: theme.colors.danger, backgroundColor: theme.colors.dangerSoft }]}>{edit.oldText.split("\n").map((line) => `- ${line}`).join("\n")}</Text><Text style={[typography.code, { fontFamily: "SpaceMono", color: theme.colors.success }]}>{edit.newText.split("\n").map((line) => `+ ${line}`).join("\n")}</Text></View>)}
      {result ? <ToolOutput block={result} /> : null}
    </View> : null}
  </View>;
}

export function MessageContent({ content, active = false, color }: { content: ContentBlock[] | null | undefined; active?: boolean; color?: string }) {
  const blocks = content ?? [];
  return <View style={{ gap: 3, width: "100%", minWidth: 0 }}>{blocks.map((block, index) => {
    // Tool results never render standalone. A paired one is shown inside its
    // ToolCall; a streaming message boundary can leave a partial result whose
    // tool_use was committed with the previous message, and dumping that raw
    // output into the bubble grows its height for as long as the tool runs.
    if (block.type === "tool_result") return null;
    if (block.type === "tool_use") return <ToolCall key={`tool-${block.id}`} block={block} active={active} result={blocks.find((item): item is Extract<ContentBlock, { type: "tool_result" }> => item.type === "tool_result" && item.tool_use_id === block.id)} />;
    return <Block key={`${block.type}-${index}`} block={block} color={color} streaming={active} />;
  })}</View>;
}

function chatBubbleStyle(theme: AppTheme, side: "user" | "assistant", local = false, maxWidth: number): ViewStyle {
  return {
    maxWidth,
    minWidth: 0,
    alignSelf: side === "user" ? "flex-end" : "flex-start",
    borderRadius: theme.radius.lg,
    borderCurve: "continuous",
    backgroundColor: side === "user" ? theme.colors.userBubble : theme.colors.assistantBubble,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
    opacity: local ? 0.72 : 1,
    ...(Platform.OS === "web" ? { userSelect: "none" as const } : null),
  };
}

function ChatBubbleFrame({
  side,
  local = false,
  copyText,
  onLongPress,
  children,
}: {
  side: "user" | "assistant";
  local?: boolean;
  copyText: string;
  onLongPress?: (text: string, origin: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  const theme = useAppTheme();
  const { width } = useWindowDimensions();
  const maxWidth = Math.max(196, Math.round(width * (side === "user" ? 0.78 : 0.86)) - 24);
  const style = chatBubbleStyle(theme, side, local, maxWidth);
  // Native text selection on the timeline captures the panel swipe; copy from the long-press menu instead.
  if (!copyText || !onLongPress) return <View style={style}>{children}</View>;
  return <Pressable accessible={false} delayLongPress={500} android_ripple={{ color: "transparent" }} onLongPress={(event: GestureResponderEvent) => {
    if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    onLongPress(copyText, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });
  }} style={style}>{children}</Pressable>;
}

function BubbleMeta({ clock, local = false, side, live = false }: { clock?: string; local?: boolean; side: "user" | "assistant"; live?: boolean }) {
  const theme = useAppTheme();
  const color = side === "user" ? theme.colors.userBubbleMeta : theme.colors.textFaint;
  if (!clock && !local && !live) return null;
  return <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 3, marginTop: 4 }}>
    {live ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: theme.colors.accent, marginRight: 2 }} /> : null}
    {local ? <Text style={[typography.micro, { color }]}>Sending</Text> : null}
    {clock ? <Text style={[typography.micro, { color, fontVariant: ["tabular-nums"] }]}>{clock}</Text> : null}
    {side === "user" && !local ? <AppIcon name="check-check" size={11} color={color} strokeWidth={2.4} /> : null}
  </View>;
}

export const MessageBubble = memo(function MessageBubble({ message, local = false, onLongPress }: { message: MessageRecord; local?: boolean; onLongPress?: (text: string, origin: { x: number; y: number }) => void }) {
  const theme = useAppTheme();
  if (!hasRenderableMessage(message)) return null;
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  if (isSystem) return <View style={{ alignItems: "center", paddingHorizontal: 24, paddingVertical: 8 }}><Text style={[typography.caption, { color: theme.colors.textFaint, textAlign: "center" }]}>{message.text || "System update"}</Text></View>;
  const thinkingLevel = requestedThinkingLevel(message.meta);
  const side = isUser ? "user" : "assistant";
  const textColor = isUser ? theme.colors.userBubbleText : undefined;
  const accent = isUser ? theme.colors.userBubbleText : theme.colors.accent;
  const copyText = messageText(message);
  return <View style={{ width: "100%", paddingHorizontal: 12, paddingVertical: 5, alignItems: isUser ? "flex-end" : "flex-start" }}>
    <ChatBubbleFrame side={side} local={local} copyText={copyText} onLongPress={onLongPress}>
      {hasRenderableContent(message.content) ? <MessageContent content={message.content} color={textColor} /> : message.text?.trim() ? <TextBlock value={message.text} accent={accent} color={textColor} /> : null}
      {message.errorMessage ? <Text style={[typography.caption, { color: isUser ? theme.colors.userBubbleText : theme.colors.danger, marginTop: 6 }]}>{message.errorMessage}</Text> : null}
      <BubbleMeta clock={formatMessageClock(message.createdAt)} local={local} side={side} />
    </ChatBubbleFrame>
    {!isUser && (message.model || thinkingLevel) ? <Text style={[typography.micro, { color: theme.colors.textFaint, marginTop: 4, marginLeft: 4 }]}>{message.model || "Agent"}{thinkingLevel ? ` · ${formatThinkingLevel(thinkingLevel)}` : ""}</Text> : null}
  </View>;
});

export function StreamCard({ content, status, runtimePhase = null, runtimeModel = null, onLongPress }: { content: ContentBlock[]; status: string; runtimePhase?: StreamView["runtimePhase"]; runtimeModel?: string | null; onLongPress?: (text: string, origin: { x: number; y: number }) => void }) {
  const theme = useAppTheme();
  const liveContent = content;
  const hasLivePreview = liveContent.some((block) => (block.type === "text" && block.text.trim().length > 0) || (block.type === "thinking" && block.thinking.trim().length > 0) || block.type === "tool_use");
  // Mirrors the web turn footer: live content is the status itself; otherwise surface
  // what the runtime is doing so quiet gaps (agent launch, model latency) don't look frozen.
  const runtimeLabel = !hasLivePreview && (status === "pending" || status === "streaming")
    ? runtimePhase === "llm_call_started"
      ? runtimeModel?.trim()
        ? `waiting ${runtimeModel.trim()}…`
        : "waiting model…"
      : status === "pending" && !hasRenderableContent(liveContent)
        ? "starting agent…"
        : null
    : null;
  const failed = status === "failed" || status === "interrupted";
  const statusLabel = status === "failed" ? "Agent failed" : status === "interrupted" ? "Generation stopped" : null;
  const live = status === "pending" || status === "streaming";
  return <View style={{ width: "100%", paddingHorizontal: 12, paddingVertical: 5, alignItems: "flex-start" }}>
    <ChatBubbleFrame side="assistant" copyText={contentText(liveContent).trim()} onLongPress={onLongPress}>
      {statusLabel ? <Text style={[typography.caption, { color: theme.colors.danger, marginBottom: hasLivePreview || runtimeLabel ? 6 : 0 }]}>{statusLabel}</Text> : null}
      {runtimeLabel ? <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{runtimeLabel}</Text> : null}
      {hasLivePreview || hasRenderableContent(liveContent) ? <MessageContent active={live} content={liveContent} /> : null}
      <BubbleMeta clock={failed ? undefined : live ? "now" : undefined} side="assistant" live={live && !failed} />
    </ChatBubbleFrame>
  </View>;
}

export async function shareMessageText(value: string) {
  await Share.share({ message: value });
}

export async function copyMessageText(value: string) {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(value);
    return;
  }
  await shareMessageText(value);
}
