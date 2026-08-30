import { Tabs } from "expo-router";
import type { ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppIcon, type IconName } from "@/src/ui";
import { useAppTheme } from "@/src/theme";

export default function TabLayout() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textFaint,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          height: 58 + insets.bottom,
          paddingTop: 7,
          paddingBottom: Math.max(insets.bottom, 6),
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600", marginBottom: 1 },
        tabBarItemStyle: { minHeight: 50 },
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Chats", tabBarIcon: (props) => <TabIcon name="messages" {...props} /> }} />
      <Tabs.Screen name="spaces" options={{ title: "Spaces", tabBarIcon: (props) => <TabIcon name="layers" {...props} /> }} />
      <Tabs.Screen name="activity" options={{ title: "Activity", tabBarIcon: (props) => <TabIcon name="activity" {...props} /> }} />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: (props) => <TabIcon name="user" {...props} /> }} />
    </Tabs>
  );
}

function TabIcon({ name, color, size, focused }: { name: IconName; color: ColorValue; size: number; focused: boolean }) {
  return <AppIcon name={name} color={color} size={Math.min(size, 24)} strokeWidth={focused ? 2.3 : 1.8} />;
}
