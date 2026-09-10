import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppIcon, BrandMark } from "@/src/ui";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";

export function AuthScreen({ onSignIn, loading, error }: { onSignIn: () => Promise<void>; loading: boolean; error: string | null }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [pressed, setPressed] = useState(false);
  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background, paddingTop: insets.top + 30, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.header}>
        <BrandMark size={54} />
        <Text style={[typography.display, { color: theme.colors.text, marginTop: 20 }]}>Cohub</Text>
        <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 9, textAlign: "center", maxWidth: 290 }]}>{t("auth.tagline")}</Text>
      </View>

      <View style={styles.center}>
        <View style={[styles.signalRow, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <View style={[styles.signalIcon, { backgroundColor: theme.colors.accentSoft }]}><AppIcon name="sparkles" size={20} color={theme.colors.accent} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{t("auth.feature.context.title")}</Text>
            <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3 }]}>{t("auth.feature.context.body")}</Text>
          </View>
        </View>
        <View style={[styles.signalRow, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface, marginTop: 10 }]}>
          <View style={[styles.signalIcon, { backgroundColor: theme.colors.infoSoft }]}><AppIcon name="sync" size={20} color={theme.colors.info} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{t("auth.feature.sync.title")}</Text>
            <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3 }]}>{t("auth.feature.sync.body")}</Text>
          </View>
        </View>
      </View>

      <View style={styles.footer}>
        {error ? <View style={[styles.error, { backgroundColor: theme.colors.dangerSoft, borderColor: theme.colors.danger }]}><AppIcon name="alert" size={16} color={theme.colors.danger} /><Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{error}</Text></View> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("auth.continue")}
          disabled={loading}
          onPress={() => void onSignIn()}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          style={[styles.signIn, { backgroundColor: pressed ? theme.colors.accentPressed : theme.colors.accent, opacity: loading ? 0.65 : 1 }]}
        >
          {loading ? <ActivityIndicator color={theme.colors.accentText} /> : <AppIcon name="arrow-right" size={19} color={theme.colors.accentText} />}
          <Text style={[typography.bodyMedium, { color: theme.colors.accentText }]}>{loading ? t("auth.opening") : t("auth.continue")}</Text>
        </Pressable>
        <Text style={[typography.micro, { color: theme.colors.textFaint, textAlign: "center", marginTop: 12 }]}>{t("auth.secure")}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 22, justifyContent: "space-between" },
  header: { alignItems: "center" },
  center: { width: "100%", maxWidth: 420, alignSelf: "center" },
  signalRow: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 16, padding: 14 },
  signalIcon: { width: 40, height: 40, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  footer: { width: "100%", maxWidth: 420, alignSelf: "center" },
  error: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 12, padding: 11, marginBottom: 10 },
  signIn: { minHeight: 52, borderRadius: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 },
});
