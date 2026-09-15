import type { MessageRecord } from "@neta-art/cohub";
import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { cancelAnimation, Extrapolation, interpolate, interpolateColor, measure, ReduceMotion, useAnimatedRef, useAnimatedStyle, useFrameCallback, useSharedValue, withSpring, type AnimatedRef } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { MessageBubble } from "@/src/components/MessageContent";
import { motion } from "@/src/motion";
import { typography, useAppTheme } from "@/src/theme";
import { COMPOSER_TEXT_PADDING } from "@/src/ui/composer-layout";
import { getBubbleMaxWidth } from "@/src/ui/message-bubble-layout";
import { interpolateSendBubbleRect, type SendBubbleRect, type SendBubbleTransition } from "@/src/ui/send-bubble-motion";

// A virtualized/queued row may never mount. This only cancels preparation; it never
// times out an animation that has started or waits for the network response.
const TARGET_WAIT_MS = 1200;

export function SendBubbleOverlay({ transition, message, rootRef, targetRef, availableWidth, spaceId, onComplete }: {
  transition: SendBubbleTransition;
  message: MessageRecord;
  rootRef: AnimatedRef<View>;
  targetRef: AnimatedRef<View>;
  availableWidth: number;
  spaceId: string | null;
  onComplete: (id: string) => void;
}) {
  const theme = useAppTheme();
  const copyRef = useAnimatedRef<View>();
  const progress = useSharedValue(0);
  const started = useSharedValue(false);
  const cancelled = useSharedValue(false);
  const waited = useSharedValue(0);
  const readyFrames = useSharedValue(0);
  const target = useSharedValue<SendBubbleRect>(transition.source);
  const id = transition.message.id;
  const source = transition.source;

  useEffect(() => () => cancelAnimation(progress), [progress]);

  useFrameCallback((frame) => {
    if (cancelled.get()) return;
    const root = measure(rootRef);
    const destination = measure(targetRef);
    const copy = measure(copyRef);
    if (root && destination && copy && destination.width > 0 && destination.height > 0 && copy.width > 0 && copy.height > 0) {
      // Track scrolling and native Markdown measurements on the UI thread. At p=1
      // the floating copy stays exactly on the real bubble until React hands it over.
      target.set({ x: destination.pageX - root.pageX, y: destination.pageY - root.pageY, width: destination.width, height: destination.height });
      if (!started.get()) {
        const sameSize = Math.abs(destination.width - copy.width) < 1 && Math.abs(destination.height - copy.height) < 1;
        readyFrames.set(sameSize ? readyFrames.get() + 1 : 0);
        if (readyFrames.get() >= 2) {
          started.set(true);
          progress.set(withSpring(1, { ...motion.sendBubble, reduceMotion: ReduceMotion.System }, (finished) => {
            if (finished) scheduleOnRN(onComplete, id);
          }));
        }
      }
    } else {
      readyFrames.set(0);
    }
    if (!started.get()) {
      waited.set(waited.get() + (frame.timeSincePreviousFrame ?? 0));
      if (waited.get() >= TARGET_WAIT_MS) {
        cancelled.set(true);
        scheduleOnRN(onComplete, id);
      }
    }
  });

  const surfaceStyle = useAnimatedStyle(() => {
    const p = progress.get();
    const rect = interpolateSendBubbleRect(source, target.get(), p);
    return {
      left: rect.x, top: rect.y, width: rect.width, height: rect.height,
      borderRadius: interpolate(p, [0, 1], [8, theme.radius.lg]),
      backgroundColor: interpolateColor(p, [0, 1], [theme.colors.surface, theme.colors.userBubble]),
    };
  });
  const sourceStyle = useAnimatedStyle(() => {
    const p = progress.get();
    const rect = interpolateSendBubbleRect(source, target.get(), p);
    return {
      opacity: interpolate(p, [0, 0.55], [1, 0], Extrapolation.CLAMP),
      transform: [{ translateX: rect.x }, { translateY: rect.y }],
    };
  });
  const copyStyle = useAnimatedStyle(() => {
    const p = progress.get();
    const rect = interpolateSendBubbleRect(source, target.get(), p);
    return {
      opacity: interpolate(p, [0.15, 0.65], [0, 1], Extrapolation.CLAMP),
      width: rect.width, height: rect.height,
      transform: [{ translateX: rect.x }, { translateY: rect.y }],
    };
  });

  return <View testID="chat-send-overlay" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.overlay}>
    <Animated.View style={[styles.surface, surfaceStyle]} />
    <Animated.View style={[styles.source, { width: source.width, height: source.height }, sourceStyle]}>
      <Text style={[typography.body, styles.sourceText, { color: theme.colors.text, transform: [{ translateY: -source.scrollY }] }]}>{transition.text}</Text>
    </Animated.View>
    <Animated.View style={[styles.copy, copyStyle]}>
      <View style={{ width: getBubbleMaxWidth(availableWidth) + 24, marginLeft: -12, marginTop: -5, alignItems: "flex-start" }}>
        <MessageBubble message={message} local={message.meta?.optimistic === true} floating surfaceHidden availableWidth={availableWidth} spaceId={spaceId} bubbleRef={copyRef} />
      </View>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 2, overflow: "hidden" },
  surface: { position: "absolute", borderCurve: "continuous" },
  source: { position: "absolute", left: 0, top: 0, overflow: "hidden" },
  sourceText: { paddingHorizontal: 5, paddingVertical: COMPOSER_TEXT_PADDING / 2, includeFontPadding: false },
  copy: { position: "absolute", left: 0, top: 0, overflow: "hidden" },
});
