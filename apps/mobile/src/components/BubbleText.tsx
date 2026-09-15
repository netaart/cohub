import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Text, View, useWindowDimensions, type LayoutChangeEvent, type TextProps, type TextStyle, type ViewStyle } from "react-native";
import { chatScrollTrace } from "@/src/data/chat-scroll-trace";
import { getBubbleMetaLayout, type BubbleTextLine, type BubbleTextMetrics } from "@/src/ui/message-bubble-layout";

export const BubbleContentWidth = createContext<number | undefined>(undefined);
export const BubbleTraceMessage = createContext<{ id: string; sessionId: string } | null>(null);

type BubbleTextProps = TextProps & {
  footer?: ReactNode;
  measurementKey: string;
  containerStyle?: ViewStyle;
};

function pinLastLineToBody(text: { width: number; height: number }, lines: BubbleTextLine[]): BubbleTextMetrics {
  const last = lines.at(-1);
  if (!last) return { ...text, lines };
  return { ...text, lines: [{ ...last, y: Math.max(0, text.height - last.height) }] };
}

function useBubbleMeta(measurementKey: string, enabled: boolean, pinLastLine = false) {
  const maxWidth = useContext(BubbleContentWidth);
  const message = useContext(BubbleTraceMessage);
  const { fontScale } = useWindowDimensions();
  const key = `${fontScale}:${maxWidth}:${measurementKey}`;
  const [lines, setLines] = useState<{ key: string; value: BubbleTextLine[] } | null>(null);
  const [textSize, setTextSize] = useState<{ width: number; height: number } | null>(null);
  const [metaSize, setMetaSize] = useState<{ width: number; height: number } | null>(null);
  const measuredLines = enabled && lines?.key === key ? lines.value : null;
  const metrics = enabled && textSize && measuredLines
    ? (pinLastLine ? pinLastLineToBody(textSize, measuredLines) : { ...textSize, lines: measuredLines })
    : null;
  const { minWidth, marginTop, inline } = getBubbleMetaLayout(metrics, enabled ? metaSize : null, maxWidth ?? textSize?.width ?? 0);
  useEffect(() => {
    if (!enabled || !chatScrollTrace.isRecording()) return;
    chatScrollTrace.record("bubble.metaLayout", "bubble", { message: message ? chatScrollTrace.alias("message", message.id) : null, session: message ? chatScrollTrace.alias("session", message.sessionId) : null, minWidth, marginTop, inline, maxWidth, textWidth: textSize?.width, textHeight: textSize?.height, metaWidth: metaSize?.width, metaHeight: metaSize?.height, lineCount: measuredLines?.length, lastLine: measuredLines?.at(-1) });
  }, [enabled, inline, marginTop, minWidth, maxWidth, measuredLines, message, metaSize, textSize]);
  return {
    maxWidth,
    minWidth,
    marginTop,
    onBodyLayout: enabled ? (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setTextSize((previous) => previous?.width === width && previous.height === height ? previous : { width, height });
    } : undefined,
    captureLines: enabled ? (value: BubbleTextLine[]) => {
      setLines((previous) => previous?.key === key && JSON.stringify(previous.value) === JSON.stringify(value) ? previous : { key, value });
    } : undefined,
    onMetaLayout: enabled ? (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setMetaSize((previous) => previous?.width === width && previous.height === height ? previous : { width, height });
    } : undefined,
  };
}

export function BubbleText({ footer, measurementKey, containerStyle, ...textProps }: BubbleTextProps) {
  const { maxWidth, minWidth, marginTop, onBodyLayout, captureLines, onMetaLayout } = useBubbleMeta(measurementKey, Boolean(footer));
  return <View style={[{ minWidth: footer ? minWidth : 0, maxWidth }, containerStyle]}>
    <Text {...textProps}
      onLayout={onBodyLayout}
      onTextLayout={captureLines ? (event) => {
        captureLines(event.nativeEvent.lines.map(({ x, y, width, height }) => ({ x, y, width, height })));
      } : undefined}
    />
    {footer ? <View onLayout={onMetaLayout} style={{ alignSelf: "flex-end", maxWidth: "100%", marginTop }}>{footer}</View> : null}
  </View>;
}

/**
 * Same clock tuck as BubbleText, for the native Markdown view that has no onTextLayout.
 * A hidden Text with the source provides last-line width; the visible body provides the box.
 */
export function BubbleMarkdown({
  footer,
  measurementKey,
  measureText,
  measureStyle,
  containerStyle,
  children,
}: {
  footer: ReactNode;
  measurementKey: string;
  measureText: string;
  measureStyle: TextStyle;
  containerStyle?: ViewStyle;
  children: ReactNode;
}) {
  const { maxWidth, minWidth, marginTop, onBodyLayout, captureLines, onMetaLayout } = useBubbleMeta(measurementKey, true, true);
  return <View style={[{ minWidth, maxWidth }, containerStyle]}>
    {captureLines ? <Text
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[measureStyle, { position: "absolute", opacity: 0, maxWidth }]}
      onTextLayout={(event) => {
        captureLines(event.nativeEvent.lines.map(({ x, y, width, height }) => ({ x, y, width, height })));
      }}
    >{measureText}</Text> : null}
    <View onLayout={onBodyLayout} style={{ minWidth: 0 }}>{children}</View>
    <View onLayout={onMetaLayout} style={{ alignSelf: "flex-end", maxWidth: "100%", marginTop }}>{footer}</View>
  </View>;
}
