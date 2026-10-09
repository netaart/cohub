import { Link, Stack } from "expo-router";
import { Text, View } from "react-native";
import { AppIcon } from "@/src/ui";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";

export default function NotFoundScreen() {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return <>
    <Stack.Screen options={{ title: t("route.notFound") }} />
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: theme.colors.background }}>
      <View style={{ width: 54, height: 54, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised }}><AppIcon name="compass" size={25} color={theme.colors.textMuted} /></View>
      <Text style={[typography.heading, { color: theme.colors.text, marginTop: 15 }]}>{t("notFound.heading")}</Text>
      <Link href="/(tabs)" style={{ marginTop: 16 }}><Text style={[typography.bodyMedium, { color: theme.colors.accent }]}>{t("notFound.back")}</Text></Link>
    </View>
  </>;
}
