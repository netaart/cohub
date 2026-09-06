import type { LucideIcon } from "lucide-react-native";
import { usePathname } from "expo-router";
import { useEffect, useState } from "react";
import { Animated, Easing, Platform, type ColorValue } from "react-native";
import { icons, type IconName } from "@/src/icons";

export type AnimatedTabIconName = "messages" | "layers" | "activity" | "user";

type AnimatedTabIconProps = {
  name: AnimatedTabIconName;
  color: ColorValue;
  size: number;
  focused: boolean;
  route: "/" | "/spaces" | "/activity" | "/profile";
};

const iconNames: Record<AnimatedTabIconName, IconName> = {
  messages: "messages",
  layers: "layers",
  activity: "activity",
  user: "user",
};

export function AnimatedTabIcon({ name, color, size, focused, route }: AnimatedTabIconProps) {
  const pathname = usePathname();
  const selected = pathname === route || (route === "/" && pathname === "/(tabs)");
  const [progress] = useState(() => new Animated.Value(selected ? 1 : 0));
  const Icon: LucideIcon = icons[iconNames[name]];

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: selected ? 1 : 0,
      duration: 140,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start();
    return () => animation.stop();
  }, [progress, selected]);

  return (
    <Animated.View
      style={{
        opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }),
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }],
      }}
    >
      <Icon size={size} color={color} strokeWidth={focused || selected ? 2 : 1.8} absoluteStrokeWidth />
    </Animated.View>
  );
}
