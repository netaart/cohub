import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, Text, TextInput, View, type LayoutChangeEvent, type TextStyle } from "react-native";
import {
  getCachedHighlightedCode,
  highlightCode,
  highlightCodeSync,
  type CodeHighlightTheme,
  type HighlightedCode,
} from "@/src/data/code-highlight";
import type { CodeLanguageId } from "@/src/data/code-language";
import { useTranslation } from "@/src/i18n";
import { typography, useAppTheme } from "@/src/theme";

const HIGHLIGHT_DEBOUNCE_MS = 160;
// Synchronous tokenization keeps the highlight in lockstep with typing for
// ordinary files; larger files fall back to the debounced async pass.
const SYNC_HIGHLIGHT_CHARS = 12_000;
const MEASURE_CHARACTERS = "0000000000";
const TAB_COLUMNS = 8;
const PADDING_HORIZONTAL = 12;
const PADDING_VERTICAL = 10;

function visualColumns(line: string) {
  let columns = 0;
  for (const character of line) {
    if (character === "\t") columns += TAB_COLUMNS - (columns % TAB_COLUMNS);
    else columns += 1;
  }
  return columns;
}

function renderLines(highlighted: HighlightedCode | null, value: string, fallbackColor: string): ReactNode {
  const lines = highlighted?.lines;
  if (!lines) return value;
  const nodes: ReactNode[] = [];
  lines.forEach((line, lineIndex) => {
    nodes.push(
      <Text key={lineIndex}>
        {line.map((token, tokenIndex) => {
          const fontStyle = token.fontStyle ?? 0;
          return (
            <Text
              key={tokenIndex}
              style={{
                color: token.color ?? fallbackColor,
                ...(fontStyle & 1 ? { fontStyle: "italic" as const } : null),
                ...(fontStyle & 2 ? { fontWeight: "700" as const } : null),
                ...(fontStyle & 4 ? { textDecorationLine: "underline" as const } : null),
                ...(fontStyle & 8 ? { textDecorationLine: "line-through" as const } : null),
              }}
            >
              {token.content}
            </Text>
          );
        })}
      </Text>,
    );
    if (lineIndex < lines.length - 1) nodes.push("\n");
  });
  return nodes;
}

export function CodeEditor({
  value,
  onChangeText,
  language,
  highlightTheme,
}: {
  value: string;
  onChangeText: (value: string) => void;
  language: CodeLanguageId | null;
  highlightTheme: CodeHighlightTheme;
}) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const [charWidth, setCharWidth] = useState(0);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [asyncHighlight, setAsyncHighlight] = useState<{ value: string; result: HighlightedCode } | null>(null);

  const syncHighlight = useMemo(() => {
    if (!language || value.length > SYNC_HIGHLIGHT_CHARS) return null;
    const cached = getCachedHighlightedCode(value, language, highlightTheme);
    if (cached) return cached;
    return highlightCodeSync(value, language, highlightTheme);
  }, [highlightTheme, language, value]);
  const highlighted = syncHighlight ?? (asyncHighlight?.value === value ? asyncHighlight.result : null);

  useEffect(() => {
    if (!language || syncHighlight) return;
    let active = true;
    const timer = setTimeout(() => {
      void highlightCode(value, language, highlightTheme).then((result) => {
        if (active && result) setAsyncHighlight({ value, result });
      }).catch(() => undefined);
    }, value.length <= SYNC_HIGHLIGHT_CHARS ? 0 : HIGHLIGHT_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [highlightTheme, language, syncHighlight, value]);

  const lines = value.split("\n");
  const lineCount = lines.length;
  const gutterWidth = charWidth > 0 ? Math.ceil(String(lineCount).length * charWidth) + 16 : 28;
  const maxColumns = lines.reduce((max, line) => Math.max(max, visualColumns(line)), 1);
  const contentWidth = charWidth > 0 ? maxColumns * charWidth + PADDING_HORIZONTAL * 2 + charWidth : undefined;
  const codeWidth = contentWidth === undefined ? Math.max(0, availableWidth - gutterWidth) : Math.max(availableWidth - gutterWidth, contentWidth);
  const editorHeight = lineCount * typography.code.lineHeight + PADDING_VERTICAL * 2;
  const metrics: TextStyle = {
    fontFamily: "SpaceMono",
    fontSize: typography.code.fontSize,
    lineHeight: typography.code.lineHeight,
    includeFontPadding: false,
    padding: 0,
    margin: 0,
  };
  const gutter = lines.map((_, index) => String(index + 1)).join("\n");

  const measureCharacter = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width > 0) setCharWidth(width / MEASURE_CHARACTERS.length);
  };

  return (
    <View onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)} style={{ alignSelf: "stretch" }}>
      <Text
        numberOfLines={1}
        onLayout={measureCharacter}
        accessible={false}
        pointerEvents="none"
        style={[metrics, { position: "absolute", top: 0, left: 0, opacity: 0 }]}
      >
        {MEASURE_CHARACTERS}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
          <Text
            selectable={false}
            accessible={false}
            style={[metrics, { width: gutterWidth, textAlign: "right", paddingRight: 8, paddingTop: PADDING_VERTICAL, color: theme.colors.textFaint }]}
          >
            {gutter}
          </Text>
          <View style={{ width: codeWidth, height: editorHeight, overflow: "hidden" }}>
            <Text
              accessible={false}
              pointerEvents="none"
              style={[metrics, { position: "absolute", top: 0, left: 0, right: 0, height: editorHeight, paddingHorizontal: PADDING_HORIZONTAL, paddingVertical: PADDING_VERTICAL, color: theme.colors.text }]}
            >
              {renderLines(highlighted, value, theme.colors.text)}
            </Text>
            <TextInput
              multiline
              value={value}
              onChangeText={onChangeText}
              scrollEnabled={false}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              textContentType="none"
              textAlignVertical="top"
              selectionColor={theme.colors.accent}
              cursorColor={theme.colors.accent}
              underlineColorAndroid="transparent"
              accessibilityLabel={t("code.editor")}
              style={[metrics, { width: "100%", height: editorHeight, paddingHorizontal: PADDING_HORIZONTAL, paddingVertical: PADDING_VERTICAL, color: "transparent" }]}
            />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
