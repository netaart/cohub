import type { LucideIcon } from "lucide-react-native";
import { usePathname } from "expo-router";
import { icons, type IconName } from "@/src/icons";
import type { ColorValue } from "react-native";

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
  const Icon: LucideIcon = icons[iconNames[name]];
  return <Icon size={size} color={color} strokeWidth={focused || selected ? 2 : 1.8} absoluteStrokeWidth />;
}
