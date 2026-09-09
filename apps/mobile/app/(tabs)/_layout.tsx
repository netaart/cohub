import { Tabs } from "expo-router";
import { AnimatedTabIcon } from "@/src/components/AnimatedTabIcon";
import { FloatingTabBar } from "@/src/components/FloatingTabBar";

export default function TabLayout() {
  // Tabs are peers, not a hierarchy: switching must never slide.
  return (
    <Tabs
      screenOptions={{ headerShown: false, animation: "none" }}
      tabBar={(props) => <FloatingTabBar {...props} />}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Chats",
          tabBarIcon: ({ color, size, focused }) => <AnimatedTabIcon name="messages" color={color} size={size} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="spaces"
        options={{
          title: "Spaces",
          tabBarIcon: ({ color, size, focused }) => <AnimatedTabIcon name="layers" color={color} size={size} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: "Activity",
          tabBarIcon: ({ color, size, focused }) => <AnimatedTabIcon name="activity" color={color} size={size} focused={focused} />,
        }}
      />
    </Tabs>
  );
}
