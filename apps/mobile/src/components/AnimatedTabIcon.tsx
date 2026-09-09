import type { LucideIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Animated, Easing, Platform, type ColorValue } from "react-native";
import { icons, type IconName } from "@/src/icons";
import { motion } from "@/src/motion";

export type AnimatedTabIconName = "messages" | "layers" | "activity";

type AnimatedTabIconProps = {
  name: AnimatedTabIconName;
  color: ColorValue;
  size: number;
  focused: boolean;
};

const iconNames: Record<AnimatedTabIconName, IconName> = {
  messages: "messages",
  layers: "layers",
  activity: "activity",
};

export function AnimatedTabIcon({ name, color, size, focused }: AnimatedTabIconProps) {
  const [progress] = useState(() => new Animated.Value(focused ? 1 : 0));
  const Icon: LucideIcon = icons[iconNames[name]];

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: focused ? 1 : 0,
      duration: motion.fade.duration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start();
    return () => animation.stop();
  }, [focused, progress]);

  return (
    <Animated.View
      style={{
        opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }),
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }],
      }}
    >
      <Icon size={size} color={color} strokeWidth={focused ? 2 : 1.8} absoluteStrokeWidth />
    </Animated.View>
  );
}
