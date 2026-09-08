import { useMemo, type ReactNode } from "react";
import { Animated, Easing, Platform, Pressable, View, type PressableAndroidRippleConfig, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { motion, press } from "@/src/motion";

type PressableScaleProps = {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: "button" | "tab" | "menuitem" | "header";
  accessibilityState?: Record<string, unknown>;
  testID?: string;
  hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number };
  style?: StyleProp<ViewStyle>;
  /** Extra style applied only while pressed (e.g. background tint). */
  pressedStyle?: StyleProp<ViewStyle>;
  /** Set false to skip the scale animation (icon buttons etc). */
  scale?: boolean;
  /** Fire a light haptic on press (native platforms with haptics support). */
  haptic?: boolean;
  androidRipple?: PressableAndroidRippleConfig;
};

/**
 * Pressable with a subtle native-feeling settle: scale down while pressed,
 * spring back on release, optional light haptic. Replaces ripple feedback.
 */
export function PressableScale({
  children,
  onPress,
  onLongPress,
  disabled = false,
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  testID,
  hitSlop,
  style,
  pressedStyle,
  scale = true,
  haptic = false,
  androidRipple,
}: PressableScaleProps) {
  const progress = useMemo(() => new Animated.Value(1), []);

  const settle = (toValue: number) => {
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue,
      duration: toValue === press.scale ? motion.pressIn.duration : motion.settle.duration,
      easing: toValue === press.scale ? Easing.out(Easing.quad) : Easing.out(Easing.back(1.4)),
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={scale && !disabled ? { transform: [{ scale: progress }] } : null}>
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={accessibilityRole}
        accessibilityState={accessibilityState}
        testID={testID}
        hitSlop={hitSlop}
        disabled={disabled}
        onPress={onPress}
        onLongPress={onLongPress}
        android_ripple={androidRipple}
        onPressIn={() => {
          if (scale) settle(press.scale);
          if (haptic && Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        }}
        onPressOut={() => {
          if (scale) settle(1);
        }}
      >
        {({ pressed }) => (
          <View style={[style, pressed ? pressedStyle : null, pressed && !scale ? { opacity: 0.72 } : null]}>
            {children}
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}
