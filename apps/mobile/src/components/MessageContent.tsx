import type { ContentBlock, MessageRecord } from "@neta-art/cohub";
import { Image, Text, View } from "react-native";
import type { ReactNode } from "react";
import { AppIcon } from "@/src/ui";
import { formatThinkingLevel, requestedThinkingLevel } from "@/src/model-catalog";
import { useAppTheme, typography } from "@/src/theme";
import { contentBlockText, hasRenderableContent, hasRenderableMessage } from "@/src/utils";

function TextBlock({ value, muted = false }: { value: string; muted?: boolean }) {
  const theme = useAppTheme();
  const lines = value.replace(/\\r\\n/g, "\\n").split("\\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let codeLanguage = "";
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push(<Text key={`paragraph-${blocks.length}`} selectable style={[typography.body, { color: muted ? theme.colors.textMuted : theme.colors.text, lineHeight: 23 }]}>{renderInlineMarkdown(text)}</Text>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(<View key={`list-${blocks.length}`} style={{ gap: 6 }}>{list.items.map((item, index) => <View key={`${index}-${item.slice(0, 12)}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}><Text style={[typography.body, { color: theme.colors.accent, lineHeight: 23, minWidth: 18 }]}>{list?.ordered ? `${index + 1}.` : "•"}</Text><Text selectable style={[typography.body, { color: muted ? theme.colors.textMuted : theme.colors.text, lineHeight: 23, flex: 1 }]}>{renderInlineMarkdown(item)}</Text></View>)}</View>);
    list = null;
  };
  const flushCode = () => {
    if (code === null) return;
    blocks.push(<View key={`code-${blocks.length}`} style={{ backgroundColor: theme.colors.background, borderRadius: 10, padding: 11, borderWidth: 1, borderColor: theme.colors.border }}><View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}><AppIcon name="code" size={13} color={theme.colors.textFaint} /><Text style={[typography.micro, { color: theme.colors.textFaint }]}>{codeLanguage || "code"}</Text></View><Text selectable style={{ color: theme.colors.textSecondary, fontFamily: "SpaceMono", fontSize: 12, lineHeight: 18 }}>{code.join("\\n")}</Text></View>);
    code = null;
    codeLanguage = "";
  };

  for (const line of lines) {
    const fence = /^\\s*```\\s*([^\\s`]*)?\\s*$/.exec(line);
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
    const heading = /^\\s{0,3}(#{1,6})\\s+(.+?)\\s*#*\\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const size = heading[1].length <= 2 ? 19 : heading[1].length <= 4 ? 17 : 15;
      blocks.push(<Text key={`heading-${blocks.length}`} selectable style={{ color: muted ? theme.colors.textMuted : theme.colors.text, fontSize: size, lineHeight: size + 6, fontWeight: "700", marginTop: 3 }}>{renderInlineMarkdown(heading[2])}</Text>);
      continue;
    }
    const quote = /^\\s*>\\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(<View key={`quote-${blocks.length}`} style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.accentBorder, paddingLeft: 10 }}><Text selectable style={[typography.body, { color: theme.colors.textMuted, lineHeight: 23 }]}>{renderInlineMarkdown(quote[1])}</Text></View>);
      continue;
    }
    const item = /^\\s*(?:[-*+]\\s+|([0-9]+)[.)]\\s+)(.+)$/.exec(line);
    if (item) {
      const ordered = Boolean(item[1]);
      if (!list || list.ordered !== ordered) {
        flushParagraph();
        flushList();
        list = { ordered, items: [] };
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
  kind: "bold" | "italic";
};

function isWordCharacter(value: string | undefined) {
  return value !== undefined && /[A-Za-z0-9]/.test(value);
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

function renderInlineMarkdown(value: string): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let nodeIndex = 0;
  while (cursor < value.length) {
    const emphasis = findInlineEmphasis(value, cursor);
    if (!emphasis) {
      nodes.push(value.slice(cursor));
      break;
    }
    if (emphasis.start > cursor) nodes.push(value.slice(cursor, emphasis.start));
    nodes.push(
      <Text key={`${nodeIndex}-${emphasis.start}`} style={emphasis.kind === "bold" ? { fontWeight: "700" } : { fontStyle: "italic" }}>
        {emphasis.content}
      </Text>,
    );
    nodeIndex += 1;
    cursor = emphasis.end;
  }
  return nodes;
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
  if (!hasRenderableMessage(message)) return null;
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  if (isSystem) return <View style={{ alignItems: "center", paddingHorizontal: 24, paddingVertical: 8 }}><Text style={[typography.caption, { color: theme.colors.textFaint, textAlign: "center" }]}>{message.text || "System update"}</Text></View>;
  const thinkingLevel = requestedThinkingLevel(message.meta);
  return <View style={{ paddingHorizontal: 16, paddingVertical: 7, alignItems: isUser ? "flex-end" : "stretch" }}>
    {!isUser ? <Text style={[typography.micro, { color: theme.colors.textMuted, marginBottom: 5, marginLeft: 2 }]}>{message.provider || "Agent"}{message.model ? ` · ${message.model}` : ""}{thinkingLevel ? ` · Thinking ${formatThinkingLevel(thinkingLevel)}` : ""}</Text> : null}
    <View style={{ maxWidth: isUser ? "86%" : "100%", borderRadius: isUser ? 17 : 13, borderTopRightRadius: isUser ? 5 : 13, backgroundColor: isUser ? theme.colors.accentSoft : theme.colors.surface, borderWidth: 1, borderColor: isUser ? theme.colors.accentBorder : theme.colors.border, paddingHorizontal: 13, paddingVertical: 11, opacity: local ? 0.72 : 1 }}>
      {hasRenderableContent(message.content) ? <MessageContent content={message.content} /> : message.text?.trim() ? <TextBlock value={message.text} /> : null}
      {local ? <Text style={[typography.micro, { color: theme.colors.textMuted, marginTop: 7 }]}>Sending…</Text> : null}
      {message.errorMessage ? <Text style={[typography.caption, { color: theme.colors.danger, marginTop: 7 }]}>{message.errorMessage}</Text> : null}
    </View>
  </View>;
}

export function StreamCard({ content, status }: { content: ContentBlock[]; status: string }) {
  const theme = useAppTheme();
  const hasContent = hasRenderableContent(content);
  const label = status === "pending"
    ? "Starting"
    : status === "failed"
      ? "Agent failed"
      : status === "interrupted"
        ? "Generation stopped"
        : "Agent is working";
  return <View style={{ marginHorizontal: 16, marginVertical: 9, borderRadius: 13, borderWidth: 1, borderColor: theme.colors.info, backgroundColor: theme.colors.infoSoft, padding: 13 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: hasContent ? 8 : 0 }}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.info }} /><Text style={[typography.caption, { color: theme.colors.info }]}>{label}</Text></View>{hasContent ? <MessageContent content={content} /> : null}</View>;
}
