import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import {
  getCachedHighlightedCode,
  highlightCode,
  type CodeHighlightTheme,
  type HighlightedCode,
} from "@/src/data/code-highlight";
import { codeLanguageLabel, resolveCodeLanguage } from "@/src/data/code-language";
import { useTranslation } from "@/src/i18n";
import { typography, useAppTheme } from "@/src/theme";
import { AppIcon } from "@/src/ui";

type CodeLine = readonly { content: string; color?: string; fontStyle?: number }[];

function plainLines(code: string): CodeLine[] {
  return code.split("\n").map((line) => [{ content: line }]);
}

function tokenStyle(token: { color?: string; fontStyle?: number }, fallbackColor: string): TextStyle {
  const fontStyle = token.fontStyle ?? 0;
  return {
    color: token.color ?? fallbackColor,
    ...(fontStyle & 1 ? { fontStyle: "italic" as const } : null),
    ...(fontStyle & 2 ? { fontWeight: "700" as const } : null),
    ...(fontStyle & 4 ? { textDecorationLine: "underline" as const } : null),
    ...(fontStyle & 8 ? { textDecorationLine: "line-through" as const } : null),
  };
}

function renderLines(lines: CodeLine[], fallbackColor: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  lines.forEach((line, lineIndex) => {
    if (line.length === 1 && line[0]) {
      nodes.push(<Text key={lineIndex} style={tokenStyle(line[0], fallbackColor)}>{line[0].content}</Text>);
    } else {
      nodes.push(
        <Text key={lineIndex}>
          {line.map((token, tokenIndex) => (
            <Text key={tokenIndex} style={tokenStyle(token, fallbackColor)}>{token.content}</Text>
          ))}
        </Text>,
      );
    }
    if (lineIndex < lines.length - 1) nodes.push("\n");
  });
  return nodes;
}

export function CodeBlock({
  code,
  language,
  showLineNumbers = false,
  streaming = false,
  style,
}: {
  code: string;
  language: string | null;
  showLineNumbers?: boolean;
  streaming?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const highlightTheme: CodeHighlightTheme = theme.mode === "dark" ? "github-dark" : "github-light";
  const languageId = resolveCodeLanguage(language);
  const cachedHighlight = useMemo(() => {
    if (streaming || !languageId) return null;
    return getCachedHighlightedCode(code, languageId, highlightTheme);
  }, [code, highlightTheme, languageId, streaming]);
  const [asyncHighlight, setAsyncHighlight] = useState<{ code: string; result: HighlightedCode } | null>(null);
  const highlighted = cachedHighlight ?? (asyncHighlight?.code === code ? asyncHighlight.result : null);

  useEffect(() => {
    if (streaming || !languageId || cachedHighlight) return;
    let active = true;
    // Defer so a large block cannot block the initial paint of a message.
    const timer = setTimeout(() => {
      void highlightCode(code, languageId, highlightTheme).then((result) => {
        if (active && result) setAsyncHighlight({ code, result });
      }).catch(() => undefined);
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [cachedHighlight, code, highlightTheme, languageId, streaming]);

  const lines: CodeLine[] = useMemo(() => highlighted?.lines ?? plainLines(code), [code, highlighted]);
  const fallbackColor = highlighted?.foreground ?? theme.colors.textSecondary;
  const label = codeLanguageLabel(languageId) ?? language;
  const gutter = showLineNumbers ? lines.map((_, index) => String(index + 1)).join("\n") : null;
  const codeTextStyle: TextStyle = {
    ...typography.code,
    fontFamily: "SpaceMono",
    color: fallbackColor,
  };

  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surfaceRaised,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {label || streaming ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, paddingTop: 8, paddingBottom: 2 }}>
          <AppIcon name="code" size={13} color={theme.colors.textFaint} />
          <Text style={[typography.micro, { color: theme.colors.textFaint }]}>
            {label ?? t("code.fallback")}{streaming ? ` · ${t("code.streaming")}` : ""}
          </Text>
        </View>
      ) : null}
      {/* Keep code inside the message width; nested horizontal scrollers mis-measure
          inside the inverted chat list on Android. */}
      <View style={{ padding: 11 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
          {gutter ? (
            <Text
              style={[
                codeTextStyle,
                {
                  color: theme.colors.textFaint,
                  textAlign: "right",
                  paddingRight: 12,
                  userSelect: "none",
                },
              ]}
            >
              {gutter}
            </Text>
          ) : null}
          <Text selectable style={[codeTextStyle, { flex: 1 }]}>{renderLines(lines, fallbackColor)}</Text>
        </View>
      </View>
    </View>
  );
}
