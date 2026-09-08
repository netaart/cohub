import { Tabs } from "expo-router";
import type { BottomTabBarButtonProps } from "expo-router/build/react-navigation/bottom-tabs/types";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnimatedTabIcon } from "@/src/components/AnimatedTabIcon";
import { typography, useAppTheme } from "@/src/theme";

const TAB_BAR_EXTRA_BOTTOM_SPACE = 10;
const TAB_BAR_CONTENT_HEIGHT = 64;

export default function TabLayout() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const bottomSpace = Math.max(insets.bottom, 0) + TAB_BAR_EXTRA_BOTTOM_SPACE;
  // BottomTabItem hardcodes a borderless platform-colored ripple; re-bind the button to a
  // plain Pressable so tabs have no ripple at all.
  const tabBarButton = ({ href: _href, ref: _ref, ...props }: BottomTabBarButtonProps) => (
    <Pressable {...props} style={[props.style, { borderRadius: 10, overflow: "hidden" }]} />
  );
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textFaint,
        tabBarActiveBackgroundColor: "transparent",
        tabBarInactiveBackgroundColor: "transparent",
        tabBarStyle: {
          backgroundColor: theme.colors.background,
          borderTopColor: "transparent",
          height: TAB_BAR_CONTENT_HEIGHT + bottomSpace,
          paddingTop: 7,
          paddingBottom: bottomSpace,
          paddingHorizontal: 6,
          shadowColor: theme.colors.shadow,
          shadowOffset: { width: 0, height: -2 },
          shadowOpacity: 0.08,
          shadowRadius: 5,
          elevation: 3,
        },
        tabBarLabelStyle: { fontSize: typography.micro.fontSize + 1, fontWeight: "600", marginBottom: 1 },
        tabBarItemStyle: { minHeight: 50, marginHorizontal: 3, marginVertical: 3, borderRadius: 10, backgroundColor: "transparent" },
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Chats", tabBarIcon: (props) => <AnimatedTabIcon name="messages" route="/" {...props} /> }} />
      <Tabs.Screen name="spaces" options={{ title: "Spaces", tabBarIcon: (props) => <AnimatedTabIcon name="layers" route="/spaces" {...props} /> }} />
      <Tabs.Screen name="activity" options={{ title: "Activity", tabBarIcon: (props) => <AnimatedTabIcon name="activity" route="/activity" {...props} /> }} />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: (props) => <AnimatedTabIcon name="user" route="/profile" {...props} /> }} />
    </Tabs>
  );
}
