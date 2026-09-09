import { useEffect } from "react";
import type { StyleProp, TextStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { GLYPH_FADE_MS } from "@/src/data/stream-reveal";

const RESTING_ALPHA = 0.25;

/**
 * One freshly revealed grapheme. The fade runs on the UI thread, so a commit
 * that adds text never waits for the animation. The reveal cadence already
 * staggers commits, so every glyph in a commit fades together: per-glyph
 * `withDelay` stalls on web and buys nothing at a 48ms commit interval.
 */
export function StreamingGlyph({ value, style }: { value: string; style: StyleProp<TextStyle> }) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) {
      progress.set(1);
      return;
    }
    progress.set(withTiming(1, { duration: GLYPH_FADE_MS, easing: Easing.out(Easing.quad) }));
  }, [progress, reduced]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: RESTING_ALPHA + (1 - RESTING_ALPHA) * progress.get() }));
  return <Animated.Text style={[style, animatedStyle]}>{value}</Animated.Text>;
}
