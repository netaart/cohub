import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Text, View, useWindowDimensions, type TextProps, type ViewStyle } from "react-native";
import { chatScrollTrace } from "@/src/data/chat-scroll-trace";
import { getBubbleMetaLayout, type BubbleTextLine } from "@/src/ui/message-bubble-layout";

export const BubbleContentWidth = createContext<number | undefined>(undefined);
export const BubbleTraceMessage = createContext<{ id: string; sessionId: string } | null>(null);

type BubbleTextProps = TextProps & {
  footer?: ReactNode;
  measurementKey: string;
  containerStyle?: ViewStyle;
};

export function BubbleText({ footer, measurementKey, containerStyle, ...textProps }: BubbleTextProps) {
  const maxWidth = useContext(BubbleContentWidth);
  const message = useContext(BubbleTraceMessage);
  const { fontScale } = useWindowDimensions();
  const key = `${fontScale}:${maxWidth}:${measurementKey}`;
  const [lines, setLines] = useState<{ key: string; value: BubbleTextLine[] } | null>(null);
  const [textSize, setTextSize] = useState<{ width: number; height: number } | null>(null);
  const [metaSize, setMetaSize] = useState<{ width: number; height: number } | null>(null);
  const measuredLines = lines?.key === key ? lines.value : null;
  const { minWidth, marginTop, inline } = getBubbleMetaLayout(textSize && measuredLines ? { ...textSize, lines: measuredLines } : null, metaSize, maxWidth ?? textSize?.width ?? 0);
  useEffect(() => {
    if (!footer || !chatScrollTrace.isRecording()) return;
    chatScrollTrace.record("bubble.metaLayout", "bubble", { message: message ? chatScrollTrace.alias("message", message.id) : null, session: message ? chatScrollTrace.alias("session", message.sessionId) : null, minWidth, marginTop, inline, maxWidth, textWidth: textSize?.width, textHeight: textSize?.height, metaWidth: metaSize?.width, metaHeight: metaSize?.height, lineCount: measuredLines?.length, lastLine: measuredLines?.at(-1) });
  }, [footer, inline, marginTop, minWidth, maxWidth, measuredLines, message, metaSize, textSize]);
  return <View style={[{ minWidth: footer ? minWidth : 0, maxWidth }, containerStyle]}>
    <Text {...textProps}
      onLayout={footer ? (event) => {
        const { width, height } = event.nativeEvent.layout;
        setTextSize((previous) => previous?.width === width && previous.height === height ? previous : { width, height });
      } : undefined}
      onTextLayout={footer ? (event) => {
        const value = event.nativeEvent.lines.map(({ x, y, width, height }) => ({ x, y, width, height }));
        setLines((previous) => previous?.key === key && JSON.stringify(previous.value) === JSON.stringify(value) ? previous : { key, value });
      } : undefined}
    />
    {footer ? <View onLayout={(event) => {
      const { width, height } = event.nativeEvent.layout;
      setMetaSize((previous) => previous?.width === width && previous.height === height ? previous : { width, height });
    }} style={{ alignSelf: "flex-end", maxWidth: "100%", marginTop }}>{footer}</View> : null}
  </View>;
}
