import { Link, Stack } from "expo-router";
import { Text, View } from "react-native";
import { AppIcon } from "@/src/ui";
import { useAppTheme, typography } from "@/src/theme";

export default function NotFoundScreen() {
  const theme = useAppTheme();
  return <>
    <Stack.Screen options={{ title: "Not found" }} />
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: theme.colors.background }}>
      <View style={{ width: 54, height: 54, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised }}><AppIcon name="compass-outline" size={25} color={theme.colors.textMuted} /></View>
      <Text style={[typography.heading, { color: theme.colors.text, marginTop: 15 }]}>This route is unavailable</Text>
      <Link href="/(tabs)" style={{ marginTop: 16 }}><Text style={[typography.bodyMedium, { color: theme.colors.accent }]}>Back to Cohub</Text></Link>
    </View>
  </>;
}
