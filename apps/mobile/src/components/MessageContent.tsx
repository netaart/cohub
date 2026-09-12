import type { ContentBlock, MessageRecord } from "@neta-art/cohub";
import * as Clipboard from "expo-clipboard";
import { Link, useRouter } from "expo-router";
import { createContext, memo, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { chatScrollTrace } from "@/src/data/chat-scroll-trace";
import { useTraceTouches } from "@/src/components/use-chat-scroll-trace";
import { ActivityIndicator, FlatList, Image, Linking, Pressable, ScrollView, Share, Text, View, useWindowDimensions, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { CodeBlock } from "@/src/components/CodeBlock";
import { StreamingGlyph } from "@/src/components/StreamingGlyph";
import { useRevealedStreamText } from "@/src/components/useRevealedStreamText";
import Reanimated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, type SharedValue } from "react-native-reanimated";
import { formatMessageClock } from "@/src/data/chat-format";
import { setImageViewerPayload } from "@/src/data/image-viewer";
import { markdownInlineText, markdownMedia, type MarkdownBlock, type MarkdownInline, type MarkdownTableAlignment } from "@/src/data/markdown";
import { WebView } from "react-native-webview";
import { graphemeLength, splitGraphemes } from "@/src/data/stream-reveal";
import { parseMarkdownEntries, StreamingMarkdownCache, type MarkdownBlockEntry } from "@/src/data/stream-markdown-cache";
import { formatToolCallCaption, toolCallPreview } from "@/src/data/tool-call";
import { compactionFromMessage, compactionStats, type CompactionInfo } from "@/src/data/compaction";
import { resolveMessageLink } from "@/src/data/message-links";
import type { StreamView } from "@/src/data/types";
import { formatThinkingLevel, requestedThinkingLevel } from "@/src/model-catalog";
import { scaleFontSize, scaleLineHeight, useAppTheme, typography, type AppTheme } from "@/src/theme";
import { useTranslation, type Translate } from "@/src/i18n";
import { AppIcon, type IconName } from "@/src/ui";
import { BUBBLE_PADDING_X, getBubbleMaxWidth } from "@/src/ui/message-bubble-layout";
import { BubbleContentWidth, BubbleText, BubbleTraceMessage } from "@/src/components/BubbleText";
import { turnSequenceForMessage } from "@/src/data/session-history";
import { hasRenderableContent, hasRenderableMessage, messageText } from "@/src/utils";

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function fadedValue(value: string, start: number, fadeFrom: number, style: StyleProp<TextStyle>, keyPrefix: string) {
  if (start >= fadeFrom) return value;
  const parts = splitGraphemes(value);
  if (start + parts.length <= fadeFrom) return value;
  return parts.map((part, index) => start + index >= fadeFrom
    ? <StreamingGlyph key={`${keyPrefix}-${index}`} value={part} style={style} />
    : part);
}

/**
 * Per-bubble rendering environment. Inline nodes several layers down need to know
 * which bubble they sit on (for code tint) and which Space owns sandbox paths;
 * threading both through every memoized markdown layer would defeat the memo.
 */
const BubbleContext = createContext<{ onUser: boolean; spaceId: string | null }>({ onUser: false, spaceId: null });

/**
 * Resolves a message URL into an in-app route or system browser. Sandbox file
 * paths need the owning Space; when it is unknown the path falls through as text.
 */
function useOpenMessageLink(spaceId: string | null) {
  const router = useRouter();
  return (url: string) => {
    const target = resolveMessageLink(url);
    if (!target) return false;
    if (target.kind === "external") {
      void Linking.openURL(target.url).catch(() => undefined);
      return true;
    }
    if (target.kind === "session") {
      router.push({ pathname: "/chat/[sessionId]", params: { sessionId: target.sessionId } });
      return true;
    }
    if (target.kind === "space") {
      router.push({ pathname: "/space/[spaceId]", params: { spaceId: target.spaceId } });
      return true;
    }
    if (!spaceId) return false;
    router.push({ pathname: "/space/[spaceId]/file", params: { spaceId, path: target.path } });
    return true;
  };
}

function InlineNodes({ nodes, accent, color, fadeTail = 0 }: { nodes: MarkdownInline[]; accent: string; color: string; fadeTail?: number }) {
  const theme = useAppTheme();
  const { onUser, spaceId } = useContext(BubbleContext);
  const openLink = useOpenMessageLink(spaceId);
  // Inline code sits on the bubble, so it needs a tint that reads on both bubble colors.
  const codeBackground = onUser ? "rgba(255, 255, 255, 0.18)" : theme.colors.surfaceRaised;
  let total = 0;
  const starts = fadeTail > 0 ? nodes.map((node) => {
    const start = total;
    total += graphemeLength(markdownInlineText(node));
    return start;
  }) : null;
  const fadeFrom = total - Math.min(fadeTail, total);
  return <>{nodes.map((node, index) => {
    const start = starts?.[index] ?? 0;
    const length = graphemeLength(markdownInlineText(node));
    const childFade = fadeTail > 0 ? Math.min(length, Math.max(0, start + length - fadeFrom)) : 0;
    if (node.type === "text") {
      if (fadeTail === 0) return node.value;
      return <Text key={`text-${index}`} style={{ color }}>{fadedValue(node.value, start, fadeFrom, { color }, `text-${index}`)}</Text>;
    }
    if (node.type === "code") {
      return <Text key={`code-${index}`} style={{ fontFamily: "SpaceMono", fontSize: Math.max(11, typography.chatBody.fontSize - 2), color, backgroundColor: codeBackground, borderRadius: 4, paddingHorizontal: 4 }}>{node.value}</Text>;
    }
    if (node.type === "mention") {
      // Mentions read as a chip: `@design-skill`, tinted like a link but without the underline.
      return <Text key={`mention-${index}`} style={{ color: accent, fontWeight: "600" }} onPress={() => openLink(node.url)}>@{node.value}</Text>;
    }
    if (node.type === "image") {
      // Inline images that point at sandbox paths cannot be fetched from the device; show them as an openable file link.
      const style = { color: accent, textDecorationLine: "underline" as const };
      return <Text key={`image-${index}`} style={style} onPress={() => openLink(node.url)}>{node.value || node.url}</Text>;
    }
    if (node.type === "link") {
      const style = { color: accent, textDecorationLine: "underline" as const };
      return <Text key={`link-${index}`} style={style} onPress={() => openLink(node.url)}><InlineNodes nodes={node.children} accent={accent} color={accent} fadeTail={childFade} /></Text>;
    }
    const style = node.type === "strong" ? { fontWeight: "700" as const, color } : { fontStyle: "italic" as const, color };
    return <Text key={`${node.type}-${index}`} style={style}><InlineNodes nodes={node.children} accent={accent} color={color} fadeTail={childFade} /></Text>;
  })}</>;
}

function MarkdownVideo({ url }: { url: string }) {
  const theme = useAppTheme();
  const width = useContext(BubbleContentWidth);
  const src = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src http: https:; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%;background:transparent}video{width:100%;height:100%;object-fit:contain}</style></head><body><video controls playsinline preload="metadata" src="${src}"></video></body></html>`;
  return <View style={{ width, aspectRatio: 16 / 9, backgroundColor: theme.colors.surfaceRaised, borderRadius: 8, overflow: "hidden" }}>
    <WebView
      source={{ html }}
      style={{ flex: 1, backgroundColor: "transparent" }}
      originWhitelist={["about:blank"]}
      onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      allowFileAccess={false}
      allowsInlineMediaPlayback
      allowsFullscreenVideo
      mediaPlaybackRequiresUserAction
      scrollEnabled={false}
    />
  </View>;
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

function MarkdownBlockView({ block, accent, textColor, fadeTail = 0, footer }: { block: MarkdownBlock; accent: string; textColor: string; fadeTail?: number; footer?: ReactNode }) {
  const theme = useAppTheme();
  const contentWidth = useContext(BubbleContentWidth);
  const measurementKey = JSON.stringify([block, typography.chatBody.fontSize]);
  if (block.type === "rule") return <View style={{ width: contentWidth, minWidth: 0, paddingVertical: 4 }}>
    <View style={{ height: 1, backgroundColor: textColor, opacity: 0.3 }} />
    {footer ? <View style={{ alignSelf: "flex-end", marginTop: 2 }}>{footer}</View> : null}
  </View>;
  if (block.type === "code" || block.type === "table") return <View style={{ width: contentWidth, minWidth: 0 }}>
    {block.type === "code" ? <CodeBlock code={block.code} language={block.language} streaming={!block.closed} /> : <MarkdownTable alignments={block.alignments} header={block.header} rows={block.rows} accent={accent} textColor={textColor} />}
    {footer ? <View style={{ alignSelf: "flex-end", marginTop: 2 }}>{footer}</View> : null}
  </View>;
  if (block.type === "heading") {
    const size = scaleFontSize(block.level <= 2 ? 19 : block.level <= 4 ? 17 : 15);
    return <BubbleText selectable footer={footer} measurementKey={measurementKey} containerStyle={{ marginTop: 3 }} style={{ color: textColor, fontSize: size, lineHeight: size + 6, fontWeight: "700" }}><InlineNodes nodes={block.inlines} accent={accent} color={textColor} fadeTail={fadeTail} /></BubbleText>;
  }
  if (block.type === "quote") {
    return <View style={{ width: contentWidth, borderLeftWidth: 3, borderLeftColor: theme.colors.accentBorder, paddingLeft: 10 }}><BubbleText selectable footer={footer} measurementKey={measurementKey} containerStyle={{ minWidth: 0 }} style={[typography.chatBody, { color: theme.colors.textMuted }]}><InlineNodes nodes={block.inlines} accent={accent} color={theme.colors.textMuted} fadeTail={fadeTail} /></BubbleText></View>;
  }
  if (block.type === "list") {
    return <View style={{ width: contentWidth, gap: 6 }}>{block.items.map((item, index) => <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}><Text style={[typography.chatBody, { color: accent, minWidth: 18 }]}>{block.ordered ? `${block.start + index}.` : "•"}</Text><BubbleText selectable footer={index === block.items.length - 1 ? footer : undefined} measurementKey={measurementKey} containerStyle={{ flex: 1, minWidth: 0 }} style={[typography.chatBody, { color: textColor }]}><InlineNodes nodes={item} accent={accent} color={textColor} fadeTail={index === block.items.length - 1 ? fadeTail : 0} /></BubbleText></View>)}</View>;
  }
  return <BubbleText selectable footer={footer} measurementKey={measurementKey} style={[typography.chatBody, { color: textColor }]}><InlineNodes nodes={block.inlines} accent={accent} color={textColor} fadeTail={fadeTail} /></BubbleText>;
}

// Streaming re-parses only the tail, so completed blocks keep their identity and
// memo skips them; the growing tail block carries the fade window.
const MemoBlock = memo(
  function MemoBlock(props: { block: MarkdownBlock; signature: string; accent: string; textColor: string; fadeTail: number; footer?: ReactNode }) {
    const contentWidth = useContext(BubbleContentWidth);
    const media = useMemo(() => markdownMedia(props.block), [props.block]);
    if (media.length === 0) return <MarkdownBlockView block={props.block} accent={props.accent} textColor={props.textColor} fadeTail={props.fadeTail} footer={props.footer} />;
    return <View style={{ gap: 9, minWidth: 0 }}>
      <MarkdownBlockView block={props.block} accent={props.accent} textColor={props.textColor} fadeTail={props.fadeTail} />
      {media.map((item) => item.type === "image"
        ? <ImageGallery key={item.url} uris={[item.url]} maxWidth={contentWidth} />
        : <MarkdownVideo key={item.url} url={item.url} />)}
      {props.footer ? <View style={{ alignSelf: "flex-end" }}>{props.footer}</View> : null}
    </View>;
  },
  (previous, next) => previous.signature === next.signature && previous.accent === next.accent && previous.textColor === next.textColor && previous.fadeTail === next.fadeTail && previous.footer === next.footer,
);

const MarkdownBlocks = memo(function MarkdownBlocks({ entries, accent, textColor, fadeTail = 0, footer }: { entries: MarkdownBlockEntry[]; accent: string; textColor: string; fadeTail?: number; footer?: ReactNode }) {
  return <>{entries.map((entry, index) => <MemoBlock key={index} block={entry.block} signature={entry.signature} accent={accent} textColor={textColor} fadeTail={index === entries.length - 1 ? fadeTail : 0} footer={index === entries.length - 1 ? footer : undefined} />)}{entries.length === 0 ? footer : null}</>;
});

const MarkdownBody = memo(function MarkdownBody({ source, accent, textColor, footer }: { source: string; accent: string; textColor: string; footer?: ReactNode }) {
  const entries = useMemo(() => parseMarkdownEntries(source), [source]);
  return <MarkdownBlocks entries={entries} accent={accent} textColor={textColor} footer={footer} />;
});

function TextBlock({ value, muted = false, accent, color, streaming = false, footer }: { value: string; muted?: boolean; accent: string; color?: string; streaming?: boolean; footer?: ReactNode }) {
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
  if (!rendered) return <View style={{ gap: 9, minWidth: 0 }}><MarkdownBody source={text} accent={accent} textColor={textColor} footer={footer} /></View>;
  // One list in document order: a block that crosses the stable boundary keeps
  // its key and signature, so memo skips it instead of remounting the block.
  return <View style={{ gap: 9, minWidth: 0 }}>
    <MarkdownBlocks entries={tailEntries.length > 0 ? [...rendered.entries, ...tailEntries] : rendered.entries} accent={accent} textColor={textColor} fadeTail={fadeTail} footer={footer} />
  </View>;
}

function imageUri(block: Extract<ContentBlock, { type: "image" }>) {
  if (block.source?.type === "url") return block.source.url;
  if (block.source?.type === "base64") return `data:${block.source.media_type};base64,${block.source.data}`;
  return null;
}

function GalleryThumbnail({ uri, index, total, size, onOpen }: { uri: string; index: number; total: number; size: number; onOpen: () => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const [pressed, setPressed] = useState(false);
  // Link.Trigger slots its child, and slotting spreads the child's style prop: a function
  // style would be flattened to {}. Track pressed state and pass a plain object instead.
  const style = {
    width: size,
    height: size,
    borderRadius: 12,
    overflow: "hidden" as const,
    backgroundColor: theme.colors.surfaceRaised,
    opacity: pressed ? 0.78 : 1,
  };
  return (
    <Link href="/image-viewer" asChild onPress={onOpen}>
      <Link.Trigger withAppleZoom>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("message.openImage", { index: index + 1, total })}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          style={style}
        >
          <Image source={{ uri }} resizeMode="cover" style={{ width: "100%", height: "100%" }} />
        </Pressable>
      </Link.Trigger>
    </Link>
  );
}

function ImageGallery({ uris, maxWidth }: { uris: string[]; maxWidth?: number }) {
  const { width } = useWindowDimensions();
  const galleryWidth = maxWidth ?? width;
  const thumbnailWidth = Math.min(164, Math.max(124, Math.min(width * 0.42, galleryWidth)));

  const galleryGesture = useMemo(() => Gesture.Native().disallowInterruption(true), []);

  return (
    <GestureDetector gesture={galleryGesture}>
      <FlatList
        data={uris}
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        alwaysBounceHorizontal
        showsHorizontalScrollIndicator={false}
        style={{ width: galleryWidth, maxWidth: "100%", height: thumbnailWidth, flexGrow: 0, flexShrink: 1 }}
        contentContainerStyle={{ gap: 8, paddingRight: 4 }}
        keyExtractor={(uri, index) => `${uri}-${index}`}
        renderItem={({ item: uri, index }) => <GalleryThumbnail uri={uri} index={index} total={uris.length} size={thumbnailWidth} onOpen={() => setImageViewerPayload({ uris, index })} />}
      />
    </GestureDetector>
  );
}

function Block({ block, color, streaming = false, footer }: { block: ContentBlock; color?: string; streaming?: boolean; footer?: ReactNode }) {
  const theme = useAppTheme();
  const accent = color ?? theme.colors.accent;
  if (block.type === "text") return <TextBlock value={block.text} accent={accent} color={color} streaming={streaming} footer={footer} />;
  if (block.type === "thinking") return <TextBlock value={block.thinking} muted accent={accent} streaming={streaming} footer={footer} />;
  if (block.type === "system_note") return <SystemNoteRow block={block} />;
  return null;
}

function SystemNoteRow({ block }: { block: Extract<ContentBlock, { type: "system_note" }> }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const title = block.note_type === "compacted" ? t("message.compaction.title") : t("chat.systemUpdate");
  const body = block.text?.trim();
  return <View style={{ borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: 9, gap: 3 }}>
    <Text style={[typography.caption, { color: theme.colors.textSecondary, fontWeight: "600" }]}>{title}</Text>
    {body ? <Text selectable style={[typography.caption, { color: theme.colors.textMuted }]}>{body}</Text> : null}
  </View>;
}

/**
 * Compaction is runtime metadata, not a reply: it renders as a boundary card
 * (mirroring the Web "Context compacted" notice) instead of an empty bubble.
 */
function CompactionNotice({ info }: { info: CompactionInfo }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const stats = compactionStats(info.meta);
  const details: string[] = [];
  if (stats.summarizedMessageCount !== null) details.push(t("message.compaction.messages", { count: stats.summarizedMessageCount }));
  if (stats.tokensBefore !== null && stats.tokensAfter !== null) details.push(t("message.compaction.context", { before: formatTokenCount(stats.tokensBefore), after: formatTokenCount(stats.tokensAfter) }));
  const hasSummary = info.summary.length > 0;
  return <View style={{ width: "100%", paddingHorizontal: 12, paddingVertical: 5 }}>
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.lg, borderCurve: "continuous", backgroundColor: theme.colors.surface, overflow: "hidden" }}>
      <Pressable accessibilityRole="button" accessibilityLabel={hasSummary ? t(expanded ? "message.compaction.collapse" : "message.compaction.expand") : t("message.compaction.title")} accessibilityState={{ expanded }} disabled={!hasSummary} onPress={() => setExpanded((value) => !value)} style={({ pressed }) => ({ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: pressed && hasSummary ? theme.colors.surfacePressed : "transparent" })}>
        <AppIcon name="archive" size={15} color={theme.colors.textMuted} />
        <Text style={[typography.caption, { color: theme.colors.textSecondary, fontWeight: "600" }]}>{t("message.compaction.title")}</Text>
        {details.length > 0 ? <Text numberOfLines={1} style={[typography.micro, { color: theme.colors.textMuted, flex: 1, textAlign: "right" }]}>{details.join(" · ")}</Text> : <View style={{ flex: 1 }} />}
        {hasSummary ? <AppIcon name={expanded ? "chevron-down" : "chevron-right"} size={14} color={theme.colors.textFaint} /> : null}
      </Pressable>
      {expanded && hasSummary ? <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, maxHeight: 320 }}>
        <ScrollView nestedScrollEnabled showsVerticalScrollIndicator contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}>
          <MarkdownBody source={info.summary} accent={theme.colors.accent} textColor={theme.colors.textSecondary} />
        </ScrollView>
      </View> : null}
    </View>
  </View>;
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
  const { t } = useTranslation();
  const text = value || t("message.tool.emptyOutput");
  return <Text selectable style={[typography.code, { fontFamily: "SpaceMono", color }]}>{text}</Text>;
}

function ToolOutput({ block }: { block: Extract<ContentBlock, { type: "tool_result" }> }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  // Running tools keep appending to `content`; the body must be height-capped
  // (mirroring the web's tail view) or an expanded bubble grows forever.
  return <View style={{ gap: 6 }}><Text style={[typography.micro, { color: block.is_error ? theme.colors.danger : theme.colors.textMuted }]}>{block.is_error ? t("message.tool.outputError") : t("message.tool.output")}</Text>{typeof block.content === "string" ? <CappedCodeText value={block.content} color={theme.colors.text} /> : <MessageContent content={block.content} />}</View>;
}

function ToolCall({ block, result, active = false }: { block: Extract<ContentBlock, { type: "tool_use" }>; result?: Extract<ContentBlock, { type: "tool_result" }>; active?: boolean }) {
  const theme = useAppTheme();
  const contentWidth = useContext(BubbleContentWidth);
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const status = result ? result.is_error ? t("message.tool.status.error") : t("message.tool.status.done") : active ? t("message.tool.status.running") : t("message.tool.status.noResult");
  const iconColor = result?.is_error ? theme.colors.danger : active && !result ? theme.colors.accent : theme.colors.textMuted;
  const preview = toolCallPreview(block.name, block.input);
  const caption = formatToolCallCaption(block.name, block.input);
  const edits = Array.isArray(block.input.edits) ? block.input.edits.filter((edit): edit is { oldText: string; newText: string } => typeof edit === "object" && edit !== null && typeof edit.oldText === "string" && typeof edit.newText === "string") : [];
  return <View style={{ width: contentWidth }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${caption}: ${status}`} accessibilityState={{ expanded }} hitSlop={8} onPress={() => setExpanded(!expanded)} style={{ minHeight: 22, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}>
      <AppIcon name={toolIcon(block.name)} size={14} color={iconColor} />
      <Text numberOfLines={1} style={{ flex: 1, fontSize: scaleFontSize(13), lineHeight: scaleLineHeight(18) }}>
        <Text style={{ color: theme.colors.text, fontWeight: "500" }}>{block.name}</Text>
        {preview ? <Text style={{ color: theme.colors.textMuted }}>{`: "${preview}"`}</Text> : null}
      </Text>
    </Pressable>
    {expanded ? <ScrollView nestedScrollEnabled showsVerticalScrollIndicator style={{ maxHeight: TOOL_DETAILS_MAX_HEIGHT, marginTop: 4 }} contentContainerStyle={{ borderLeftWidth: 1, borderLeftColor: theme.colors.border, paddingLeft: 12, paddingRight: 8, gap: 8 }}>
      <BubbleContentWidth.Provider value={contentWidth === undefined ? undefined : Math.max(0, contentWidth - 21)}>
      <Text style={[typography.micro, { color: theme.colors.textMuted }]}>{t("message.tool.input")}</Text>
      <CappedCodeText value={JSON.stringify(block.input, null, 2)} color={theme.colors.text} />
      {edits.map((edit, index) => <View key={index}><Text style={[typography.code, { fontFamily: "SpaceMono", color: theme.colors.danger, backgroundColor: theme.colors.dangerSoft }]}>{edit.oldText.split("\n").map((line) => `- ${line}`).join("\n")}</Text><Text style={[typography.code, { fontFamily: "SpaceMono", color: theme.colors.success }]}>{edit.newText.split("\n").map((line) => `+ ${line}`).join("\n")}</Text></View>)}
      {result ? <ToolOutput block={result} /> : null}
      </BubbleContentWidth.Provider>
    </ScrollView> : null}
  </View>;
}

export function MessageContent({ content, active = false, color, imageMaxWidth, footer }: { content: ContentBlock[] | null | undefined; active?: boolean; color?: string; imageMaxWidth?: number; footer?: ReactNode }) {
  const blocks = content ?? [];
  const contentWidth = useContext(BubbleContentWidth);
  const imageUris = blocks.flatMap((block) => block.type === "image" ? [imageUri(block)].filter((uri): uri is string => Boolean(uri)) : []);
  const firstImageIndex = blocks.findIndex((block) => block.type === "image" && imageUri(block) !== null);
  const lastVisibleIndex = blocks.findLastIndex((block, index) => block.type === "text" ? Boolean(block.text.trim()) : block.type === "thinking" ? Boolean(block.thinking.trim()) : block.type === "tool_use" || block.type === "system_note" || (block.type === "image" && index === firstImageIndex));
  const last = blocks[lastVisibleIndex];
  // Appending text invalidates native line measurements. Keep the live clock out of that
  // measurement cycle so each chunk cannot add and then remove a footer row.
  const textFooter = !active && (last?.type === "text" || last?.type === "thinking");
  return <View style={{ gap: 3, minWidth: 0 }}>{blocks.map((block, index) => {
    // Tool results never render standalone. A paired one is shown inside its
    // ToolCall; a streaming message boundary can leave a partial result whose
    // tool_use was committed with the previous message, and dumping that raw
    // output into the bubble grows its height for as long as the tool runs.
    if (block.type === "tool_result" || (block.type === "text" && !block.text.trim()) || (block.type === "thinking" && !block.thinking.trim())) return null;
    if (block.type === "tool_use") return <ToolCall key={`tool-${block.id}`} block={block} active={active} result={blocks.find((item): item is Extract<ContentBlock, { type: "tool_result" }> => item.type === "tool_result" && item.tool_use_id === block.id)} />;
    if (block.type === "image") {
      if (index !== firstImageIndex) return null;
      return imageUris.length > 0 ? <ImageGallery key="image-gallery" uris={imageUris} maxWidth={imageMaxWidth ?? contentWidth} /> : null;
    }
    return <Block key={`${block.type}-${index}`} block={block} color={color} streaming={active} footer={index === lastVisibleIndex && textFooter ? footer : undefined} />;
  })}{footer && !textFooter ? <View style={{ alignSelf: "flex-end", marginTop: 2 }}>{footer}</View> : null}</View>;
}

function chatBubbleStyle(theme: AppTheme, side: "user" | "assistant", local: boolean, maxWidth: number): ViewStyle {
  return {
    maxWidth,
    minWidth: 0,
    position: "relative",
    alignSelf: side === "user" ? "flex-end" : "flex-start",
    borderRadius: theme.radius.lg,
    borderCurve: "continuous",
    backgroundColor: side === "user" ? theme.colors.userBubble : theme.colors.assistantBubble,
    paddingHorizontal: BUBBLE_PADDING_X,
    paddingTop: 8,
    paddingBottom: 7,
    opacity: local ? 0.72 : 1,
  };
}

function ChatBubbleFrame({
  side,
  local = false,
  children,
  maxWidth,
}: {
  side: "user" | "assistant";
  local?: boolean;
  children: ReactNode;
  maxWidth: number;
}) {
  const theme = useAppTheme();
  const style = chatBubbleStyle(theme, side, local, maxWidth);
  return <BubbleContentWidth.Provider value={Math.max(0, maxWidth - BUBBLE_PADDING_X * 2)}><View style={style}>{children}</View></BubbleContentWidth.Provider>;
}

function TypingDot({ progress, index, color }: { progress: SharedValue<number>; index: number; color: string }) {
  const style = useAnimatedStyle(() => ({
    opacity: 0.35 + progress.value * (index === 1 ? 0.65 : 0.35),
    transform: [{ translateY: progress.value * (index === 1 ? -3 : -1) }],
  }));
  return <Reanimated.View style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }, style]} />;
}

function TypingIndicator() {
  const theme = useAppTheme();
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withRepeat(withSequence(withTiming(1, { duration: 420 }), withTiming(0, { duration: 420 })), -1, true);
  }, [progress]);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minWidth: 42, minHeight: 20 }}>
    {[0, 1, 2].map((index) => <TypingDot key={index} progress={progress} index={index} color={theme.colors.textMuted} />)}
  </View>;
}

function BubbleMeta({ clock, local = false, side, live = false, t }: { clock?: string; local?: boolean; side: "user" | "assistant"; live?: boolean; t: Translate }) {
  const theme = useAppTheme();
  const color = side === "user" ? theme.colors.userBubbleMeta : theme.colors.textFaint;
  if (!clock && !local && !live) return null;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 3, maxWidth: "100%" }}>
    {live ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: theme.colors.accent, marginRight: 2 }} /> : null}
    {local ? <Text style={[typography.micro, { color }]}>{t("chat.sending")}</Text> : null}
    {clock ? <Text style={[typography.micro, { color, fontVariant: ["tabular-nums"] }]}>{clock}</Text> : null}
    {side === "user" && !local ? <AppIcon name="check-check" size={11} color={color} strokeWidth={2.4} /> : null}
  </View>;
}

export const MessageBubble = memo(function MessageBubble({ message, local = false, onCopy, onFork, forkDisabled = false, forking = false, spaceId = null, availableWidth }: { message: MessageRecord; local?: boolean; onCopy?: (text: string) => void; onFork?: (message: MessageRecord) => void; forkDisabled?: boolean; forking?: boolean; spaceId?: string | null; availableWidth?: number }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const [copied, setCopied] = useState(false);
  const tracing = useSyncExternalStore(chatScrollTrace.subscribe, chatScrollTrace.isRecording, chatScrollTrace.isRecording);
  const traceIdentity = () => ({
    session: chatScrollTrace.alias("session", message.sessionId),
    message: chatScrollTrace.alias("message", message.id),
    role: message.role,
    sequence: message.sequence,
    turnSequence: turnSequenceForMessage(message),
    textLength: message.text?.length ?? 0,
    blocks: (message.content ?? []).map((block) => ({ type: block.type, length: block.type === "text" ? block.text.length : block.type === "thinking" ? block.thinking.length : null })),
    theme: theme.mode, fontSize: typography.chatBody.fontSize,
  });
  const traceTouches = useTraceTouches("bubble", traceIdentity, tracing);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timeout);
  }, [copied]);
  const isUser = message.role === "user";
  const bubbleEnvironment = useMemo(() => ({ onUser: isUser, spaceId }), [isUser, spaceId]);
  const compaction = compactionFromMessage(message);
  if (compaction && (message.content ?? []).every((block) => block.type === "system_note")) return <CompactionNotice info={compaction} />;
  if (!hasRenderableMessage(message)) return null;
  const isSystem = message.role === "system";
  if (isSystem) return <View style={{ alignItems: "center", paddingHorizontal: 24, paddingVertical: 8 }}><Text style={[typography.caption, { color: theme.colors.textFaint, textAlign: "center" }]}>{message.text || t("chat.systemUpdate")}</Text></View>;
  const thinkingLevel = requestedThinkingLevel(message.meta);
  const inputTokenValue = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0);
  const cachedInputTokens = typeof message.usage?.cacheRead === "number" && Number.isFinite(message.usage.cacheRead) && message.usage.cacheRead > 0 ? formatTokenCount(message.usage.cacheRead) : null;
  const inputTokens = inputTokenValue > 0 ? formatTokenCount(inputTokenValue) : null;
  const outputTokens = typeof message.usage?.output === "number" && Number.isFinite(message.usage.output) && message.usage.output > 0 ? formatTokenCount(message.usage.output) : null;
  const side = isUser ? "user" : "assistant";
  const textColor = isUser ? theme.colors.userBubbleText : undefined;
  const accent = isUser ? theme.colors.userBubbleText : theme.colors.accent;
  const copyText = messageText(message);
  const maxWidth = getBubbleMaxWidth(availableWidth ?? width);
  const clock = formatMessageClock(message.createdAt);
  const footer = clock || local ? <BubbleMeta clock={clock} local={local} side={side} t={t} /> : undefined;
  return <BubbleContext.Provider value={bubbleEnvironment}><View {...traceTouches} onLayout={tracing ? (event) => chatScrollTrace.record("bubble.layout", "bubble", { ...traceIdentity(), ...event.nativeEvent.layout }) : undefined} style={{ width: "100%", paddingHorizontal: 12, paddingVertical: 5, alignItems: isUser ? "flex-end" : "flex-start" }}>
    <BubbleTraceMessage.Provider value={message}><ChatBubbleFrame side={side} local={local} maxWidth={maxWidth}>
      {hasRenderableContent(message.content) ? <MessageContent content={message.content} color={textColor} imageMaxWidth={maxWidth - BUBBLE_PADDING_X * 2} footer={message.errorMessage ? undefined : footer} /> : message.text?.trim() ? <TextBlock value={message.text} accent={accent} color={textColor} footer={message.errorMessage ? undefined : footer} /> : !message.errorMessage ? footer : null}
      {message.errorMessage ? <BubbleText selectable footer={footer} measurementKey={`${message.errorMessage}:${typography.caption.fontSize}`} containerStyle={{ marginTop: 6 }} style={[typography.caption, { color: isUser ? theme.colors.userBubbleText : theme.colors.danger }]}>{message.errorMessage}</BubbleText> : null}
    </ChatBubbleFrame></BubbleTraceMessage.Provider>
    {/* One string child with a definite width: separate runs and shrink-wrapped layout have dropped the output segment on some Android devices. */}
    {!isUser && (message.model || thinkingLevel || inputTokens || outputTokens) ? <Text selectable style={[typography.micro, { color: theme.colors.textFaint, marginTop: 4, marginLeft: 4, alignSelf: "stretch" }]}>{`${message.model || t("chat.model.agent")}${thinkingLevel ? ` · ${formatThinkingLevel(thinkingLevel)}` : ""}${inputTokens ? ` · ↑${inputTokens}${cachedInputTokens ? ` ${t("message.tokens.cached", { count: cachedInputTokens })}` : ""}` : ""}${outputTokens ? ` · ↓${outputTokens}` : " · ↓MISSING"}`}</Text> : null}
    {copyText && !isUser ? <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3, marginLeft: side === "assistant" ? 4 : 0, marginRight: side === "user" ? 4 : 0 }}>
      {onCopy ? <Pressable accessibilityRole="button" accessibilityLabel={copied ? t("chat.copied") : t("chat.copy")} onPress={() => { onCopy(copyText); setCopied(true); }} hitSlop={6} style={({ pressed }) => ({ width: 36, height: 36, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.55 : 1 })}><AppIcon name={copied ? "check" : "copy"} size={14} color={copied ? theme.colors.success : theme.colors.textFaint} /></Pressable> : null}
      {!isUser && onFork && typeof message.meta?.turnId === "string" ? <Pressable accessibilityRole="button" accessibilityLabel={t("chat.fork")} disabled={forkDisabled} onPress={() => onFork(message)} hitSlop={6} style={({ pressed }) => ({ width: 36, height: 36, alignItems: "center", justifyContent: "center", opacity: forkDisabled ? 0.45 : pressed ? 0.55 : 1 })}>{forking ? <ActivityIndicator size="small" color={theme.colors.textFaint} /> : <AppIcon name="git-fork" size={14} color={theme.colors.textFaint} />}</Pressable> : null}
    </View> : null}
  </View></BubbleContext.Provider>;
});

export function StreamCard({ content, status, runtimePhase = null, runtimeModel = null, availableWidth }: { content: ContentBlock[]; status: string; runtimePhase?: StreamView["runtimePhase"]; runtimeModel?: string | null; availableWidth?: number }) {
  const theme = useAppTheme();
  const { width } = useWindowDimensions();
  const maxWidth = getBubbleMaxWidth(availableWidth ?? width);
  const { t } = useTranslation();
  const liveContent = content;
  const hasLivePreview = liveContent.some((block) => (block.type === "text" && block.text.trim().length > 0) || (block.type === "thinking" && block.thinking.trim().length > 0) || block.type === "tool_use");
  // Mirrors the web turn footer: live content is the status itself; otherwise surface
  // what the runtime is doing so quiet gaps (agent launch, model latency) don't look frozen.
  const runtimeLabel = !hasLivePreview && (status === "pending" || status === "streaming")
    ? runtimePhase === "llm_call_started"
      ? runtimeModel?.trim()
        ? t("message.stream.waitingModel", { model: runtimeModel.trim() })
        : t("message.stream.waitingGeneric")
      : status === "pending" && !hasRenderableContent(liveContent)
        ? t("message.stream.starting")
        : null
    : null;
  const failed = status === "failed" || status === "interrupted";
  const statusLabel = status === "failed" ? t("message.stream.failed") : status === "interrupted" ? t("message.stream.stopped") : null;
  const live = status === "pending" || status === "streaming";
  const hasContent = hasLivePreview || hasRenderableContent(liveContent);
  const footer = live && !failed ? <BubbleMeta clock={formatMessageClock(new Date().toISOString())} side="assistant" live t={t} /> : undefined;
  return <View style={{ width: "100%", paddingHorizontal: 12, paddingVertical: 5, alignItems: "flex-start" }}>
    <ChatBubbleFrame side="assistant" maxWidth={maxWidth}>
      {!statusLabel && !hasContent && !runtimeLabel ? <View><TypingIndicator />{footer ? <View style={{ alignSelf: "flex-end", marginTop: 2 }}>{footer}</View> : null}</View> : null}
      {statusLabel ? <Text style={[typography.caption, { color: theme.colors.danger, marginBottom: hasLivePreview || runtimeLabel ? 6 : 0 }]}>{statusLabel}</Text> : null}
      {runtimeLabel ? <BubbleText footer={hasContent ? undefined : footer} measurementKey={`${runtimeLabel}:${typography.caption.fontSize}`} style={[typography.caption, { color: theme.colors.textMuted }]}>{runtimeLabel}</BubbleText> : null}
      {hasContent ? <MessageContent active={live} content={liveContent} footer={footer} /> : null}
    </ChatBubbleFrame>
  </View>;
}

export async function shareMessageText(value: string) {
  await Share.share({ message: value });
}

export async function copyMessageText(value: string) {
  await Clipboard.setStringAsync(value);
}
