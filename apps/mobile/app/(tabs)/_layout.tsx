import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnimatedTabIcon } from "@/src/components/AnimatedTabIcon";
import { useAppTheme } from "@/src/theme";

const TAB_BAR_EXTRA_BOTTOM_SPACE = 10;
const TAB_BAR_CONTENT_HEIGHT = 64;

export default function TabLayout() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const bottomSpace = Math.max(insets.bottom, 0) + TAB_BAR_EXTRA_BOTTOM_SPACE;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textFaint,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          height: TAB_BAR_CONTENT_HEIGHT + bottomSpace,
          paddingTop: 6,
          paddingBottom: bottomSpace,
          paddingHorizontal: 4,
          shadowColor: theme.colors.shadow,
          shadowOffset: { width: 0, height: -3 },
          shadowOpacity: 0.12,
          shadowRadius: 8,
          elevation: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600", marginBottom: 1 },
        tabBarItemStyle: { minHeight: 52, marginHorizontal: 3, marginVertical: 3, borderRadius: 18 },
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
