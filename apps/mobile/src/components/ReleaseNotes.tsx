import { Linking, Text, View, type ColorValue } from "react-native";
import type { ReactNode } from "react";
import { useAppTheme, typography } from "@/src/theme";

type ReleaseNotesProps = {
  content: string | null;
};

type ReleaseBlock =
  | { kind: "heading"; level: 1 | 2 | 3; content: string }
  | { kind: "paragraph"; content: string }
  | { kind: "bullet"; content: string; marker: string }
  | { kind: "ordered"; content: string; marker: string }
  | { kind: "quote"; content: string }
  | { kind: "code"; content: string; language: string | null }
  | { kind: "rule" };

export function ReleaseNotes({ content }: ReleaseNotesProps) {
  const theme = useAppTheme();
  if (!content?.trim()) {
    return (
      <Text style={[typography.body, { color: theme.colors.textMuted }]}>No release notes were published.</Text>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      {parseReleaseBlocks(content).map((block, index) => (
        <ReleaseBlockView key={`${block.kind}-${index}`} block={block} />
      ))}
    </View>
  );
}

function parseReleaseBlocks(value: string): ReleaseBlock[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReleaseBlock[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ kind: "paragraph", content: text });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = /^\s*```\s*([^\s`]*)?\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const language = fence[1]?.trim() || null;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", content: codeLines.join("\n").trimEnd(), language });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3, content: heading[2]! });
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: "bullet", content: bullet[1]!, marker: "•" });
      index += 1;
      continue;
    }

    const ordered = /^\s*(\d+)[.)]\s+(.+?)\s*$/.exec(line);
    if (ordered) {
      flushParagraph();
      blocks.push({ kind: "ordered", content: ordered[2]!, marker: `${ordered[1]}.` });
      index += 1;
      continue;
    }

    const quote = /^\s*>\s?(.*?)\s*$/.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: "quote", content: quote[1]! });
      index += 1;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flushParagraph();
  return blocks;
}

function ReleaseBlockView({ block }: { block: ReleaseBlock }) {
  const theme = useAppTheme();
  if (block.kind === "rule") {
    return <View style={{ height: 1, backgroundColor: theme.colors.border }} />;
  }
  if (block.kind === "code") {
    return (
      <View style={[styles.codeBlock, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}>
        {block.language ? <Text style={[typography.micro, { color: theme.colors.textFaint, marginBottom: 7 }]}>{block.language}</Text> : null}
        <Text selectable style={[styles.codeText, { color: theme.colors.textSecondary }]}>{block.content || " "}</Text>
      </View>
    );
  }
  if (block.kind === "heading") {
    const headingStyle = block.level === 1 ? typography.heading : block.level === 2 ? typography.bodyMedium : typography.bodyMedium;
    return <Text style={[headingStyle, { color: theme.colors.text, marginTop: block.level === 1 ? 3 : 1 }]}>{renderInline(block.content, theme.colors.accent)}</Text>;
  }
  if (block.kind === "bullet" || block.kind === "ordered") {
    return (
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 9 }}>
        <Text style={[typography.bodyMedium, { color: theme.colors.accent, width: block.kind === "ordered" ? 24 : 13, textAlign: block.kind === "ordered" ? "right" : "center" }]}>{block.marker}</Text>
        <Text selectable style={[typography.body, { color: theme.colors.text, flex: 1 }]}>{renderInline(block.content, theme.colors.accent)}</Text>
      </View>
    );
  }
  if (block.kind === "quote") {
    return (
      <View style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.accentBorder, paddingLeft: 11 }}>
        <Text selectable style={[typography.body, { color: theme.colors.textSecondary }]}>{renderInline(block.content, theme.colors.accent)}</Text>
      </View>
    );
  }
  return <Text selectable style={[typography.body, { color: theme.colors.text, lineHeight: 23 }]}>{renderInline(block.content, theme.colors.accent)}</Text>;
}

function renderInline(value: string, linkColor: ColorValue): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    if (match[3]) {
      const url = match[3];
      nodes.push(
        <Text
          key={`link-${key}`}
          accessibilityRole="link"
          style={{ color: linkColor, textDecorationLine: "underline" }}
          onPress={() => void Linking.openURL(url).catch(() => undefined)}
        >
          {match[2]}
        </Text>,
      );
    } else if (match[4]) {
      nodes.push(<Text key={`code-${key}`} style={styles.inlineCode}>{match[4]}</Text>);
    } else if (match[5] || match[6]) {
      nodes.push(<Text key={`bold-${key}`} style={{ fontWeight: "700" }}>{match[5] ?? match[6]}</Text>);
    } else if (match[7]) {
      nodes.push(<Text key={`strike-${key}`} style={{ textDecorationLine: "line-through" }}>{match[7]}</Text>);
    } else if (match[8]) {
      nodes.push(<Text key={`italic-${key}`} style={{ fontStyle: "italic" }}>{match[8]}</Text>);
    } else if (match[9]) {
      nodes.push(<Text key={`italic-${key}`} style={{ fontStyle: "italic" }}>{match[9]}</Text>);
    }
    cursor = match.index + match[0].length;
    key += 1;
  }

  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

const styles = {
  codeBlock: { padding: 11, borderWidth: 1, borderRadius: 10 },
  codeText: { fontFamily: "SpaceMono", fontSize: 12, lineHeight: 18 },
  inlineCode: { fontFamily: "SpaceMono", fontSize: 12 },
} satisfies Record<string, object>;
