import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useAppTheme } from "@/src/theme";

export default function TabLayout() {
  const theme = useAppTheme();
  return (
    <NativeTabs
      tintColor={theme.colors.accent}
      iconColor={{ default: theme.colors.textMuted, selected: theme.colors.accent }}
      labelStyle={{ default: { color: theme.colors.textMuted }, selected: { color: theme.colors.accent } }}
      minimizeBehavior="onScrollDown"
    >
       <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} md="forum" />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="spaces">
        <NativeTabs.Trigger.Icon sf={{ default: "square.stack.3d.up", selected: "square.stack.3d.up.fill" }} md="layers" />
        <NativeTabs.Trigger.Label>Spaces</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Icon sf="waveform.path.ecg" md="monitoring" />
        <NativeTabs.Trigger.Label>Activity</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
