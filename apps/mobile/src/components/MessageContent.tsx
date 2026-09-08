import type { ContentBlock, MessageRecord } from "@neta-art/cohub";
import { Image, Linking, Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import { useState, type ReactNode } from "react";
import { AppIcon, type IconName } from "@/src/ui";
import { formatThinkingLevel, requestedThinkingLevel } from "@/src/model-catalog";
import { useAppTheme, typography, type AppTheme } from "@/src/theme";
import { formatMessageClock } from "@/src/data/chat-format";
import { formatToolCallCaption, toolCallPreview } from "@/src/data/tool-call";
import type { StreamView } from "@/src/data/types";
import { hasRenderableContent, hasRenderableMessage } from "@/src/utils";

function TextBlock({ value, muted = false, accent, color }: { value: string; muted?: boolean; accent: string; color?: string }) {
  const theme = useAppTheme();
  const textColor = muted ? theme.colors.textMuted : (color ?? theme.colors.text);
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let codeLanguage = "";
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push(<Text key={`paragraph-${blocks.length}`} selectable style={[typography.body, { color: textColor, lineHeight: 23 }]}>{renderInlineMarkdown(text, accent)}</Text>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const currentList = list;
    blocks.push(<View key={`list-${blocks.length}`} style={{ gap: 6 }}>{currentList.items.map((item, index) => <View key={`${index}-${item.slice(0, 12)}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}><Text style={[typography.body, { color: accent, lineHeight: 23, minWidth: 18 }]}>{currentList.ordered ? `${currentList.start + index}.` : "•"}</Text><Text selectable style={[typography.body, { color: textColor, lineHeight: 23, flex: 1 }]}>{renderInlineMarkdown(item, accent)}</Text></View>)}</View>);
    list = null;
  };
  const flushCode = () => {
    if (code === null) return;
    blocks.push(<View key={`code-${blocks.length}`} style={{ backgroundColor: theme.colors.background, borderRadius: 10, padding: 11, borderWidth: 1, borderColor: theme.colors.border }}><View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}><AppIcon name="code" size={13} color={theme.colors.textFaint} /><Text style={[typography.micro, { color: theme.colors.textFaint }]}>{codeLanguage || "code"}</Text></View><Text selectable style={{ color: theme.colors.textSecondary, fontFamily: "SpaceMono", fontSize: 12, lineHeight: 18 }}>{code.join("\n")}</Text></View>);
    code = null;
    codeLanguage = "";
  };

  for (const line of lines) {
    const fence = (code !== null ? /^\s*```\s*$/ : /^\s*```\s*([^\s`]*)?\s*$/).exec(line);
    if (fence) {
      if (code !== null) flushCode();
      else {
        flushParagraph();
        flushList();
        code = [];
        codeLanguage = fence[1] ?? "";
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const size = heading[1].length <= 2 ? 19 : heading[1].length <= 4 ? 17 : 15;
      blocks.push(<Text key={`heading-${blocks.length}`} selectable style={{ color: textColor, fontSize: size, lineHeight: size + 6, fontWeight: "700", marginTop: 3 }}>{renderInlineMarkdown(heading[2], accent)}</Text>);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(<View key={`quote-${blocks.length}`} style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.accentBorder, paddingLeft: 10 }}><Text selectable style={[typography.body, { color: theme.colors.textMuted, lineHeight: 23 }]}>{renderInlineMarkdown(quote[1], accent)}</Text></View>);
      continue;
    }
    const item = /^\s*(?:[-*+]\s+|([0-9]+)[.)]\s+)(.+)$/.exec(line);
    if (item) {
      const ordered = Boolean(item[1]);
      if (!list || list.ordered !== ordered) {
        flushParagraph();
        flushList();
        list = { ordered, start: ordered ? Number(item[1]) : 1, items: [] };
      }
      list.items.push(item[2]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (code !== null) flushCode();
  flushParagraph();
  flushList();
  return <View style={{ gap: 9 }}>{blocks}</View>;
}

type InlineEmphasis = {
  start: number;
  end: number;
  content: string;
  kind: "bold" | "italic" | "link";
  url?: string;
};

function isWordCharacter(value: string | undefined) {
  return value !== undefined && /[A-Za-z0-9]/.test(value);
}

function findInlineLink(value: string, startAt: number): InlineEmphasis | null {
  const start = value.indexOf("[", startAt);
  if (start < 0 || value[start - 1] === "\\") return null;
  const labelEnd = value.indexOf("](", start + 1);
  if (labelEnd < 0) return null;
  const urlStart = labelEnd + 2;
  const urlEnd = value.indexOf(")", urlStart);
  if (urlEnd < 0) return null;
  const url = value.slice(urlStart, urlEnd).trim();
  if (!/^(https?:\/\/|\/)/.test(url)) return null;
  const content = value.slice(start + 1, labelEnd);
  if (findInlineEmphasis(content, 0)) return null;
  return { start, end: urlEnd + 1, content, kind: "link", url };
}

function findInlineEmphasis(value: string, startAt: number): InlineEmphasis | null {
  for (let index = startAt; index < value.length; index += 1) {
    const marker = value[index];
    if (marker !== "*" && marker !== "_") continue;
    if (value[index - 1] === "\\") continue;

    const isBold = marker === "*" && value[index + 1] === "*";
    const markerLength = isBold ? 2 : 1;
    if (marker === "*" && !isBold && (value[index - 1] === "*" || value[index + 1] === "*")) continue;
    if (marker === "_" && (value[index - 1] === "_" || value[index + 1] === "_" || isWordCharacter(value[index - 1]))) continue;

    const contentStart = index + markerLength;
    if (!value[contentStart] || /\s/.test(value[contentStart])) continue;
    const closingMarker = marker.repeat(markerLength);
    let closing = value.indexOf(closingMarker, contentStart);
    while (closing >= 0) {
      if (value[closing - 1] === "\\") {
        closing = value.indexOf(closingMarker, closing + markerLength);
        continue;
      }
      const content = value.slice(contentStart, closing);
      const lastContentCharacter = content[content.length - 1];
      const closingAfter = value[closing + markerLength];
      const validEnd = Boolean(content) && !/\s/.test(lastContentCharacter ?? "") &&
        !(marker === "_" && (closingAfter === "_" || isWordCharacter(closingAfter))) &&
        !(marker === "*" && !isBold && (value[closing - 1] === "*" || closingAfter === "*"));
      if (validEnd) {
        return { start: index, end: closing + markerLength, content, kind: isBold ? "bold" : "italic" };
      }
      closing = value.indexOf(closingMarker, closing + markerLength);
    }
  }
  return null;
}

function renderInlineMarkdown(value: string, accent: string): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let nodeIndex = 0;
  while (cursor < value.length) {
    const emphasis = findInlineEmphasis(value, cursor);
    const link = findInlineLink(value, cursor);
    if (!emphasis && !link) {
      nodes.push(value.slice(cursor));
      break;
    }
    const next = (emphasis && (!link || emphasis.start <= link.start)) ? emphasis : link;
    if (!next) {
      nodes.push(value.slice(cursor));
      break;
    }
    if (next.start > cursor) nodes.push(value.slice(cursor, next.start));
    if (next.kind === "bold" || next.kind === "italic") {
      nodes.push(
        <Text key={`${nodeIndex}-${next.start}`} style={next.kind === "bold" ? { fontWeight: "700" } : { fontStyle: "italic" }}>
          {next.content}
        </Text>,
      );
    } else {
      const label = next.content.trim() || next.url;
      nodes.push(
        <Text key={`${nodeIndex}-${next.start}`} style={{ color: accent, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(next.url!).catch(() => undefined)}>
          {label}
        </Text>,
      );
    }
    nodeIndex += 1;
    cursor = next.end;
  }
  return nodes;
}

function Block({ block, color }: { block: ContentBlock; color?: string }) {
  const theme = useAppTheme();
  const accent = color ?? theme.colors.accent;
  if (block.type === "text") return <TextBlock value={block.text} accent={accent} color={color} />;
  if (block.type === "thinking") return <TextBlock value={block.thinking} muted accent={accent} />;
  if (block.type === "image" && block.source?.type === "url") {
    return <Image source={{ uri: block.source.url }} resizeMode="contain" style={{ width: "100%", height: 220, borderRadius: 12, backgroundColor: theme.colors.surfaceRaised }} />;
  }
  if (block.type === "tool_use") return <ToolCall block={block} />;
  if (block.type === "tool_result") return <ToolOutput block={block} />;
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

function ToolOutput({ block }: { block: Extract<ContentBlock, { type: "tool_result" }> }) {
  const theme = useAppTheme();
  return <View style={{ gap: 6 }}><Text style={[typography.micro, { color: block.is_error ? theme.colors.danger : theme.colors.textMuted }]}>OUT{block.is_error ? " · Error" : ""}</Text>{typeof block.content === "string" ? <ScrollView horizontal><Text selectable style={{ fontFamily: "SpaceMono", fontSize: 12, lineHeight: 19, color: theme.colors.text }}>{block.content || "(empty output)"}</Text></ScrollView> : <MessageContent content={block.content} />}</View>;
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
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, lineHeight: 18 }}>
        <Text style={{ color: theme.colors.text, fontWeight: "500" }}>{block.name}</Text>
        {preview ? <Text style={{ color: theme.colors.textMuted }}>{`: "${preview}"`}</Text> : null}
      </Text>
    </Pressable>
    {expanded ? <View style={{ borderLeftWidth: 1, borderLeftColor: theme.colors.border, paddingLeft: 12, gap: 8, marginTop: 4 }}>
      <Text style={[typography.micro, { color: theme.colors.textMuted }]}>IN</Text>
      <ScrollView horizontal><Text selectable style={{ fontFamily: "SpaceMono", fontSize: 12, lineHeight: 19, color: theme.colors.text }}>{JSON.stringify(block.input, null, 2)}</Text></ScrollView>
      {edits.map((edit, index) => <ScrollView horizontal key={index}><View><Text selectable style={{ fontFamily: "SpaceMono", fontSize: 12, lineHeight: 19, color: theme.colors.danger, backgroundColor: theme.colors.dangerSoft }}>{edit.oldText.split("\n").map((line) => `- ${line}`).join("\n")}</Text><Text selectable style={{ fontFamily: "SpaceMono", fontSize: 12, lineHeight: 19, color: theme.colors.success }}>{edit.newText.split("\n").map((line) => `+ ${line}`).join("\n")}</Text></View></ScrollView>)}
      {result ? <ToolOutput block={result} /> : null}
    </View> : null}
  </View>;
}

export function MessageContent({ content, active = false, color }: { content: ContentBlock[] | null | undefined; active?: boolean; color?: string }) {
  const blocks = content ?? [];
  const calls = new Set(blocks.filter((block) => block.type === "tool_use").map((block) => block.id));
  return <View style={{ gap: 3 }}>{blocks.map((block, index) => {
    if (block.type === "tool_result" && calls.has(block.tool_use_id)) return null;
    if (block.type === "tool_use") return <ToolCall key={`tool-${block.id}`} block={block} active={active} result={blocks.find((item): item is Extract<ContentBlock, { type: "tool_result" }> => item.type === "tool_result" && item.tool_use_id === block.id)} />;
    return <Block key={`${block.type}-${index}`} block={block} color={color} />;
  })}</View>;
}

function chatBubbleStyle(theme: AppTheme, side: "user" | "assistant", local = false): ViewStyle {
  return {
    maxWidth: side === "user" ? "78%" : "86%",
    borderRadius: theme.radius.lg,
    borderCurve: "continuous",
    backgroundColor: side === "user" ? theme.colors.userBubble : theme.colors.assistantBubble,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
    opacity: local ? 0.72 : 1,
  };
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

export function MessageBubble({ message, local = false }: { message: MessageRecord; local?: boolean }) {
  const theme = useAppTheme();
  if (!hasRenderableMessage(message)) return null;
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  if (isSystem) return <View style={{ alignItems: "center", paddingHorizontal: 24, paddingVertical: 8 }}><Text style={[typography.caption, { color: theme.colors.textFaint, textAlign: "center" }]}>{message.text || "System update"}</Text></View>;
  const thinkingLevel = requestedThinkingLevel(message.meta);
  const side = isUser ? "user" : "assistant";
  const textColor = isUser ? theme.colors.userBubbleText : undefined;
  const accent = isUser ? theme.colors.userBubbleText : theme.colors.accent;
  return <View style={{ paddingHorizontal: 12, paddingVertical: 5, alignItems: isUser ? "flex-end" : "flex-start" }}>
    <View style={chatBubbleStyle(theme, side, local)}>
      {hasRenderableContent(message.content) ? <MessageContent content={message.content} color={textColor} /> : message.text?.trim() ? <TextBlock value={message.text} accent={accent} color={textColor} /> : null}
      {message.errorMessage ? <Text style={[typography.caption, { color: isUser ? theme.colors.userBubbleText : theme.colors.danger, marginTop: 6 }]}>{message.errorMessage}</Text> : null}
      <BubbleMeta clock={formatMessageClock(message.createdAt)} local={local} side={side} />
    </View>
    {!isUser && (message.model || thinkingLevel) ? <Text style={[typography.micro, { color: theme.colors.textFaint, marginTop: 4, marginLeft: 4 }]}>{message.model || "Agent"}{thinkingLevel ? ` · ${formatThinkingLevel(thinkingLevel)}` : ""}</Text> : null}
  </View>;
}

export function StreamCard({ content, intermediateMessages = [], status, runtimePhase = null, runtimeModel = null }: { content: ContentBlock[]; intermediateMessages?: StreamView["intermediateMessages"]; status: string; runtimePhase?: StreamView["runtimePhase"]; runtimeModel?: string | null }) {
  const theme = useAppTheme();
  const liveContent = [...intermediateMessages.flatMap((message) => message.content.length ? message.content : message.text ? [{ type: "text" as const, text: message.text }] : []), ...content];
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
  return <View style={{ paddingHorizontal: 12, paddingVertical: 5, alignItems: "flex-start" }}>
    <View style={chatBubbleStyle(theme, "assistant")}>
      {statusLabel ? <Text style={[typography.caption, { color: theme.colors.danger, marginBottom: hasLivePreview || runtimeLabel ? 6 : 0 }]}>{statusLabel}</Text> : null}
      {runtimeLabel ? <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{runtimeLabel}</Text> : null}
      {hasLivePreview || hasRenderableContent(liveContent) ? <MessageContent active={live} content={liveContent} /> : null}
      <BubbleMeta clock={failed ? undefined : live ? "now" : undefined} side="assistant" live={live && !failed} />
    </View>
  </View>;
}
