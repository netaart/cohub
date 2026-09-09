import type { ContentBlock, MessageRecord } from "@neta-art/cohub";
import * as Clipboard from "expo-clipboard";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Image, Linking, Modal, Pressable, ScrollView, Share, Text, View, useWindowDimensions, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CodeBlock } from "@/src/components/CodeBlock";
import { StreamingGlyph } from "@/src/components/StreamingGlyph";
import { useRevealedStreamText } from "@/src/components/useRevealedStreamText";
import { formatMessageClock } from "@/src/data/chat-format";
import type { MarkdownBlock, MarkdownInline, MarkdownTableAlignment } from "@/src/data/markdown";
import { graphemeLength, splitGraphemes } from "@/src/data/stream-reveal";
import { parseMarkdownEntries, StreamingMarkdownCache, type MarkdownBlockEntry } from "@/src/data/stream-markdown-cache";
import { formatToolCallCaption, toolCallPreview } from "@/src/data/tool-call";
import type { StreamView } from "@/src/data/types";
import { formatThinkingLevel, requestedThinkingLevel } from "@/src/model-catalog";
import { scaleFontSize, scaleLineHeight, useAppTheme, typography, type AppTheme } from "@/src/theme";
import { AppIcon, type IconName } from "@/src/ui";
import { hasRenderableContent, hasRenderableMessage, messageText } from "@/src/utils";

function fadedValue(value: string, start: number, fadeFrom: number, style: StyleProp<TextStyle>, keyPrefix: string) {
  if (start >= fadeFrom) return value;
  const parts = splitGraphemes(value);
  if (start + parts.length <= fadeFrom) return value;
  return parts.map((part, index) => start + index >= fadeFrom
    ? <StreamingGlyph key={`${keyPrefix}-${index}`} value={part} style={style} />
    : part);
}

function InlineNodes({ nodes, accent, color, fadeTail = 0 }: { nodes: MarkdownInline[]; accent: string; color: string; fadeTail?: number }) {
  const theme = useAppTheme();
  const lengths = fadeTail > 0 ? nodes.map((node) => graphemeLength(node.value)) : null;
  const starts = lengths?.map((_, index) => lengths.slice(0, index).reduce((sum, value) => sum + value, 0)) ?? null;
  const total = lengths?.reduce((sum, value) => sum + value, 0) ?? 0;
  const fadeFrom = total - Math.min(fadeTail, total);
  return <>{nodes.map((node, index) => {
    const start = starts?.[index] ?? 0;
    if (node.type === "text") {
      if (fadeTail === 0) return node.value;
      return <Text key={`text-${index}`} style={{ color }}>{fadedValue(node.value, start, fadeFrom, { color }, `text-${index}`)}</Text>;
    }
    if (node.type === "code") {
      return <Text key={`code-${index}`} style={{ fontFamily: "SpaceMono", fontSize: Math.max(11, typography.chatBody.fontSize - 2), color, backgroundColor: theme.colors.surfaceRaised, borderRadius: 4, paddingHorizontal: 4 }}>{node.value}</Text>;
    }
    if (node.type === "link") {
      const style = { color: accent, textDecorationLine: "underline" as const };
      return <Text key={`link-${index}`} style={style} onPress={() => void Linking.openURL(node.url).catch(() => undefined)}>{fadedValue(node.value, start, fadeFrom, style, `link-${index}`)}</Text>;
    }
    const style = node.type === "strong" ? { fontWeight: "700" as const, color } : { fontStyle: "italic" as const, color };
    return <Text key={`${node.type}-${index}`} style={style}>{fadedValue(node.value, start, fadeFrom, style, `${node.type}-${index}`)}</Text>;
  })}</>;
}

function MarkdownTable({ alignments, header, rows, accent, textColor }: { alignments: MarkdownTableAlignment[]; header: MarkdownInline[][]; rows: MarkdownInline[][][]; accent: string; textColor: string }) {
  const theme = useAppTheme();
  const [viewportWidth, setViewportWidth] = useState(0);
  const columnCount = Math.max(header.length, alignments.length, ...rows.map((row) => row.length), 1);
  // Keep the table inside the message width. A nested horizontal scroller is
  // unreliable inside the inverted chat list on Android.
  return <View style={{ width: "100%", minWidth: 0 }} onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}>
    <View style={{ width: viewportWidth || "100%", borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: "hidden" }}>
      {[header, ...rows].map((row, rowIndex) => (
        <View key={rowIndex} style={{ flexDirection: "row", backgroundColor: rowIndex === 0 ? theme.colors.surfaceRaised : "transparent" }}>
          {Array.from({ length: columnCount }, (_, cellIndex) => row[cellIndex] ?? []).map((cell, cellIndex) => (
            <View key={cellIndex} style={{ flex: 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 7, borderTopWidth: rowIndex === 0 ? 0 : 1, borderLeftWidth: cellIndex === 0 ? 0 : 1, borderColor: theme.colors.border }}>
              <Text selectable style={[typography.chatBody, { color: textColor, fontWeight: rowIndex === 0 ? "600" : "400", textAlign: alignments[cellIndex] ?? "left" }]}>
                <InlineNodes nodes={cell} accent={accent} color={textColor} />
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  </View>;
}

function MarkdownBlockView({ block, accent, textColor, fadeTail = 0 }: { block: MarkdownBlock; accent: string; textColor: string; fadeTail?: number }) {
  const theme = useAppTheme();
  if (block.type === "code") return <CodeBlock code={block.code} language={block.language} streaming={!block.closed} />;
  if (block.type === "table") return <MarkdownTable alignments={block.alignments} header={block.header} rows={block.rows} accent={accent} textColor={textColor} />;
  if (block.type === "heading") {
    const size = scaleFontSize(block.level <= 2 ? 19 : block.level <= 4 ? 17 : 15);
    return <Text selectable style={{ color: textColor, fontSize: size, lineHeight: size + 6, fontWeight: "700", marginTop: 3 }}><InlineNodes nodes={block.inlines} accent={accent} color={textColor} fadeTail={fadeTail} /></Text>;
  }
  if (block.type === "quote") {
    return <View style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.accentBorder, paddingLeft: 10 }}><Text selectable style={[typography.chatBody, { color: theme.colors.textMuted }]}><InlineNodes nodes={block.inlines} accent={accent} color={theme.colors.textMuted} fadeTail={fadeTail} /></Text></View>;
  }
  if (block.type === "list") {
    return <View style={{ gap: 6 }}>{block.items.map((item, index) => <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}><Text style={[typography.chatBody, { color: accent, minWidth: 18 }]}>{block.ordered ? `${block.start + index}.` : "•"}</Text><Text selectable style={[typography.chatBody, { color: textColor, flex: 1 }]}><InlineNodes nodes={item} accent={accent} color={textColor} fadeTail={index === block.items.length - 1 ? fadeTail : 0} /></Text></View>)}</View>;
  }
  return <Text selectable style={[typography.chatBody, { color: textColor }]}><InlineNodes nodes={block.inlines} accent={accent} color={textColor} fadeTail={fadeTail} /></Text>;
}

// Streaming re-parses only the tail, so completed blocks keep their identity and
// memo skips them; the growing tail block carries the fade window.
const MemoBlock = memo(
  function MemoBlock(props: { block: MarkdownBlock; signature: string; accent: string; textColor: string; fadeTail: number }) {
    return <MarkdownBlockView block={props.block} accent={props.accent} textColor={props.textColor} fadeTail={props.fadeTail} />;
  },
  (previous, next) => previous.signature === next.signature && previous.accent === next.accent && previous.textColor === next.textColor && previous.fadeTail === next.fadeTail,
);

const MarkdownBlocks = memo(function MarkdownBlocks({ entries, accent, textColor, fadeTail = 0 }: { entries: MarkdownBlockEntry[]; accent: string; textColor: string; fadeTail?: number }) {
  return <>{entries.map((entry, index) => <MemoBlock key={index} block={entry.block} signature={entry.signature} accent={accent} textColor={textColor} fadeTail={index === entries.length - 1 ? fadeTail : 0} />)}</>;
});

const MarkdownBody = memo(function MarkdownBody({ source, accent, textColor }: { source: string; accent: string; textColor: string }) {
  const entries = useMemo(() => parseMarkdownEntries(source), [source]);
  return <MarkdownBlocks entries={entries} accent={accent} textColor={textColor} />;
});

function TextBlock({ value, muted = false, accent, color, streaming = false }: { value: string; muted?: boolean; accent: string; color?: string; streaming?: boolean }) {
  const theme = useAppTheme();
  const textColor = muted ? theme.colors.textMuted : (color ?? theme.colors.text);
  const { text, fadeTail } = useRevealedStreamText(value, streaming);
  const [cache] = useState(() => new StreamingMarkdownCache());
  // Keep the same block list after completion so the final text does not
  // remount; a message that never streamed stays on the one-shot body.
  const rendered = useMemo(
    () => (streaming || cache.hasStreamed ? cache.update(text) : null),
    [cache, streaming, text],
  );
  const tail = rendered?.tail ?? "";
  const tailEntries = useMemo(() => (tail ? parseMarkdownEntries(tail) : []), [tail]);
  if (!rendered) return <View style={{ gap: 9, width: "100%", minWidth: 0 }}><MarkdownBody source={text} accent={accent} textColor={textColor} /></View>;
  // One list in document order: a block that crosses the stable boundary keeps
  // its key and signature, so memo skips it instead of remounting the block.
  return <View style={{ gap: 9, width: "100%", minWidth: 0 }}>
    <MarkdownBlocks entries={tailEntries.length > 0 ? [...rendered.entries, ...tailEntries] : rendered.entries} accent={accent} textColor={textColor} fadeTail={fadeTail} />
  </View>;
}

function imageUri(block: Extract<ContentBlock, { type: "image" }>) {
  if (block.source?.type === "url") return block.source.url;
  if (block.source?.type === "base64") return `data:${block.source.media_type};base64,${block.source.data}`;
  return null;
}

function ImageGallery({ uris }: { uris: string[] }) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [viewerKey, setViewerKey] = useState(0);
  const thumbnailWidth = Math.min(164, Math.max(124, width * 0.42));
  const viewerWidth = Math.max(1, width);

  const galleryGesture = useMemo(() => Gesture.Native().disallowInterruption(true), []);
  const openImage = (index: number) => {
    setViewerKey((current) => current + 1);
    setSelectedIndex(index);
  };

  return <>
    <GestureDetector gesture={galleryGesture}>
      <FlatList
        data={uris}
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        alwaysBounceHorizontal
        showsHorizontalScrollIndicator={false}
        style={{ width: "100%", height: thumbnailWidth, flexGrow: 0 }}
        contentContainerStyle={{ gap: 8, paddingRight: 4 }}
        keyExtractor={(uri, index) => `${uri}-${index}`}
        renderItem={({ item: uri, index }) => <Pressable accessibilityRole="button" accessibilityLabel={`Open image ${index + 1} of ${uris.length}`} onPress={() => openImage(index)} style={({ pressed }) => ({ width: thumbnailWidth, height: thumbnailWidth, borderRadius: 12, overflow: "hidden", backgroundColor: theme.colors.surfaceRaised, opacity: pressed ? 0.78 : 1 })}>
          <Image source={{ uri }} resizeMode="cover" style={{ width: "100%", height: "100%" }} />
        </Pressable>}
      />
    </GestureDetector>
    <Modal visible={selectedIndex !== null} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => setSelectedIndex(null)}>
      <View style={{ flex: 1, backgroundColor: "rgba(0, 0, 0, 0.96)" }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close image viewer" onPress={() => setSelectedIndex(null)} style={{ position: "absolute", zIndex: 2, top: insets.top + 8, right: 14, width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.14)" }}>
          <AppIcon name="x" size={22} color="#ffffff" />
        </Pressable>
        <View pointerEvents="none" style={{ position: "absolute", zIndex: 2, top: insets.top + 19, left: 18 }}><Text style={[typography.caption, { color: "#ffffff" }]}>{(selectedIndex ?? 0) + 1} / {uris.length}</Text></View>
        <FlatList
          key={`image-viewer-${viewerKey}`}
          data={uris}
          horizontal
          pagingEnabled
          initialScrollIndex={selectedIndex ?? 0}
          getItemLayout={(_, index) => ({ length: viewerWidth, offset: viewerWidth * index, index })}
          onMomentumScrollEnd={(event) => setSelectedIndex(Math.round(event.nativeEvent.contentOffset.x / viewerWidth))}
          keyExtractor={(uri, index) => `${uri}-${index}`}
          showsHorizontalScrollIndicator={false}
          renderItem={({ item: uri }) => <View style={{ width: viewerWidth, height, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 }}><Image source={{ uri }} resizeMode="contain" style={{ width: "100%", height: "82%" }} /></View>}
        />
      </View>
    </Modal>
  </>;
}

function Block({ block, color, streaming = false }: { block: ContentBlock; color?: string; streaming?: boolean }) {
  const theme = useAppTheme();
  const accent = color ?? theme.colors.accent;
  if (block.type === "text") return <TextBlock value={block.text} accent={accent} color={color} streaming={streaming} />;
  if (block.type === "thinking") return <TextBlock value={block.thinking} muted accent={accent} streaming={streaming} />;
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
const TOOL_DETAILS_MAX_HEIGHT = 420;

function CappedCodeText({ value, color }: { value: string; color: string }) {
  const text = value || "(empty output)";
  return <Text selectable style={[typography.code, { fontFamily: "SpaceMono", color }]}>{text}</Text>;
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
    {expanded ? <ScrollView nestedScrollEnabled showsVerticalScrollIndicator style={{ maxHeight: TOOL_DETAILS_MAX_HEIGHT, marginTop: 4 }} contentContainerStyle={{ borderLeftWidth: 1, borderLeftColor: theme.colors.border, paddingLeft: 12, paddingRight: 8, gap: 8 }}>
      <Text style={[typography.micro, { color: theme.colors.textMuted }]}>IN</Text>
      <CappedCodeText value={JSON.stringify(block.input, null, 2)} color={theme.colors.text} />
      {edits.map((edit, index) => <View key={index}><Text selectable style={[typography.code, { fontFamily: "SpaceMono", color: theme.colors.danger, backgroundColor: theme.colors.dangerSoft }]}>{edit.oldText.split("\n").map((line) => `- ${line}`).join("\n")}</Text><Text selectable style={[typography.code, { fontFamily: "SpaceMono", color: theme.colors.success }]}>{edit.newText.split("\n").map((line) => `+ ${line}`).join("\n")}</Text></View>)}
      {result ? <ToolOutput block={result} /> : null}
    </ScrollView> : null}
  </View>;
}

export function MessageContent({ content, active = false, color }: { content: ContentBlock[] | null | undefined; active?: boolean; color?: string }) {
  const blocks = content ?? [];
  const imageUris = blocks.flatMap((block) => block.type === "image" ? [imageUri(block)].filter((uri): uri is string => Boolean(uri)) : []);
  const firstImageIndex = blocks.findIndex((block) => block.type === "image" && imageUri(block) !== null);
  return <View style={{ gap: 3, width: "100%", minWidth: 0 }}>{blocks.map((block, index) => {
    // Tool results never render standalone. A paired one is shown inside its
    // ToolCall; a streaming message boundary can leave a partial result whose
    // tool_use was committed with the previous message, and dumping that raw
    // output into the bubble grows its height for as long as the tool runs.
    if (block.type === "tool_result") return null;
    if (block.type === "tool_use") return <ToolCall key={`tool-${block.id}`} block={block} active={active} result={blocks.find((item): item is Extract<ContentBlock, { type: "tool_result" }> => item.type === "tool_result" && item.tool_use_id === block.id)} />;
    if (block.type === "image") {
      if (index !== firstImageIndex) return null;
      return imageUris.length > 0 ? <ImageGallery key="image-gallery" uris={imageUris} /> : null;
    }
    return <Block key={`${block.type}-${index}`} block={block} color={color} streaming={active} />;
  })}</View>;
}

function chatBubbleStyle(theme: AppTheme, side: "user" | "assistant", local = false, maxWidth: number): ViewStyle {
  return {
    maxWidth,
    ...(side === "assistant" ? { width: maxWidth } : null),
    minWidth: 0,
    alignSelf: side === "user" ? "flex-end" : "flex-start",
    borderRadius: theme.radius.lg,
    borderCurve: "continuous",
    backgroundColor: side === "user" ? theme.colors.userBubble : theme.colors.assistantBubble,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
    opacity: local ? 0.72 : 1,
  };
}

function ChatBubbleFrame({
  side,
  local = false,
  children,
}: {
  side: "user" | "assistant";
  local?: boolean;
  children: ReactNode;
}) {
  const theme = useAppTheme();
  const { width } = useWindowDimensions();
  const maxWidth = Math.max(196, Math.round(width * (side === "user" ? 0.78 : 0.86)) - 24);
  const style = chatBubbleStyle(theme, side, local, maxWidth);
  // Native text selection on the timeline captures the panel swipe; copy from the long-press menu instead.
  return <View style={style}>{children}</View>;
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

export const MessageBubble = memo(function MessageBubble({ message, local = false, onCopy, onFork, forkDisabled = false, forking = false }: { message: MessageRecord; local?: boolean; onCopy?: (text: string) => void; onFork?: (message: MessageRecord) => void; forkDisabled?: boolean; forking?: boolean }) {
  const theme = useAppTheme();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timeout);
  }, [copied]);
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
    <ChatBubbleFrame side={side} local={local}>
      {hasRenderableContent(message.content) ? <MessageContent content={message.content} color={textColor} /> : message.text?.trim() ? <TextBlock value={message.text} accent={accent} color={textColor} /> : null}
      {message.errorMessage ? <Text selectable style={[typography.caption, { color: isUser ? theme.colors.userBubbleText : theme.colors.danger, marginTop: 6 }]}>{message.errorMessage}</Text> : null}
      <BubbleMeta clock={formatMessageClock(message.createdAt)} local={local} side={side} />
    </ChatBubbleFrame>
    {!isUser && (message.model || thinkingLevel) ? <Text selectable style={[typography.micro, { color: theme.colors.textFaint, marginTop: 4, marginLeft: 4 }]}>{message.model || "Agent"}{thinkingLevel ? ` · ${formatThinkingLevel(thinkingLevel)}` : ""}</Text> : null}
    {copyText ? <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3, marginLeft: side === "assistant" ? 4 : 0, marginRight: side === "user" ? 4 : 0 }}>
      {onCopy ? <Pressable accessibilityRole="button" accessibilityLabel={copied ? "Message copied" : "Copy message"} onPress={() => { onCopy(copyText); setCopied(true); }} hitSlop={6} style={({ pressed }) => ({ width: 36, height: 36, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.55 : 1 })}><AppIcon name={copied ? "check" : "copy"} size={14} color={copied ? theme.colors.success : theme.colors.textFaint} /></Pressable> : null}
      {!isUser && onFork && typeof message.meta?.turnId === "string" ? <Pressable accessibilityRole="button" accessibilityLabel="Fork conversation here" disabled={forkDisabled} onPress={() => onFork(message)} hitSlop={6} style={({ pressed }) => ({ width: 36, height: 36, alignItems: "center", justifyContent: "center", opacity: forkDisabled ? 0.45 : pressed ? 0.55 : 1 })}>{forking ? <ActivityIndicator size="small" color={theme.colors.textFaint} /> : <AppIcon name="git-fork" size={14} color={theme.colors.textFaint} />}</Pressable> : null}
    </View> : null}
  </View>;
});

export function StreamCard({ content, status, runtimePhase = null, runtimeModel = null }: { content: ContentBlock[]; status: string; runtimePhase?: StreamView["runtimePhase"]; runtimeModel?: string | null }) {
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
    <ChatBubbleFrame side="assistant">
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
  await Clipboard.setStringAsync(value);
}
