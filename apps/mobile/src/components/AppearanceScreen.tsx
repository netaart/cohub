import { useRouter } from "expo-router";
import { Pressable, ScrollView, Switch, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  setPureBlackPreference,
  setThemePreference,
  type AppTheme,
  type ThemePreference,
  useAppTheme,
  usePureBlackPreference,
  useThemePreference,
  typography,
} from "@/src/theme";
import { AppIcon, DetailTopBar, Screen, SectionHeader } from "@/src/ui";

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: "monitor" | "sun" | "moon" }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

type PreviewColors = Pick<AppTheme["colors"], "background" | "surface" | "surfaceRaised" | "border" | "accent" | "text" | "textMuted">;

export function AppearanceScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <DetailTopBar title="Appearance" subtitle="Theme and display" onBack={() => router.back()} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <AppearanceContent />
      </ScrollView>
    </Screen>
  );
}

export function AppearanceContent() {
  const theme = useAppTheme();
  const preference = useThemePreference();
  const pureBlack = usePureBlackPreference();
  const { width } = useWindowDimensions();
  const previewWidth = Math.max(108, Math.min(124, (width - 48) / 3.05));

  return (
    <View testID="appearance-content">
      <View style={styles.intro}>
        <Text style={[typography.title, { color: theme.colors.text }]}>Appearance</Text>
        <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 6, maxWidth: 520 }]}>Choose how Cohub looks on this device.</Text>
      </View>

      <SectionHeader title="Theme" />
      <View style={[styles.segmented, { marginHorizontal: 16, borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.background }]}>
        {THEME_OPTIONS.map((option, index) => {
          const selected = preference === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ selected, checked: selected }}
              aria-checked={selected}
              onPress={() => void setThemePreference(option.value)}
              android_ripple={{ color: theme.colors.pressOverlay }}
              style={({ pressed }) => [
                styles.segment,
                index > 0 ? { borderLeftWidth: 1, borderLeftColor: theme.colors.borderStrong } : null,
                { backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : "transparent" },
              ]}
            >
              <AppIcon name={option.icon} size={15} color={selected ? theme.colors.accent : theme.colors.textMuted} />
              <Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textSecondary }]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 }}
      >
        {THEME_OPTIONS.map((option) => {
          const selected = preference === option.value;
          const previewMode = option.value === "system" ? theme.mode : option.value;
          return (
            <ThemePreviewCard
              key={option.value}
              label={option.label}
              mode={previewMode}
              pureBlack={pureBlack && previewMode === "dark"}
              selected={selected}
              width={previewWidth}
              onPress={() => void setThemePreference(option.value)}
            />
          );
        })}
      </ScrollView>

      <View style={[styles.group, { marginTop: 16, marginHorizontal: 16, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <View style={[styles.settingRow, { borderBottomColor: theme.colors.border }]}>
          <View style={[styles.settingIcon, { backgroundColor: theme.colors.surfaceRaised }]}>
            <AppIcon name="moon" size={17} color={theme.colors.textMuted} />
          </View>
          <View style={styles.settingText}>
            <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>Pure black dark mode</Text>
            <Text numberOfLines={2} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>Use black surfaces when a dark theme is active.</Text>
          </View>
          <Switch
            accessibilityLabel="Pure black dark mode"
            value={pureBlack}
            disabled={preference === "light"}
            onValueChange={(value) => void setPureBlackPreference(value)}
            trackColor={{ false: theme.colors.borderStrong, true: theme.colors.accentBorder }}
            thumbColor={pureBlack ? theme.colors.accent : theme.colors.textFaint}
            ios_backgroundColor={theme.colors.borderStrong}
          />
        </View>
      </View>

      <SectionHeader title="Current palette" />
      <View style={[styles.currentPalette, { marginHorizontal: 16, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.accent }} />
          <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{preferenceLabel(preference)} · {appliedModeLabel(theme.mode, pureBlack)}</Text>
        </View>
        <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 5 }]}>Applied to navigation, Chat, Files, and settings.</Text>
      </View>
    </View>
  );
}

function preferenceLabel(preference: ThemePreference) {
  return THEME_OPTIONS.find((option) => option.value === preference)?.label ?? "System";
}

function appliedModeLabel(mode: AppTheme["mode"], pureBlack: boolean) {
  if (mode === "dark") return pureBlack ? "Pure black" : "Dark";
  return "Light";
}

function ThemePreviewCard({ label, mode, pureBlack, selected, width, onPress }: { label: string; mode: "light" | "dark"; pureBlack: boolean; selected: boolean; width: number; onPress: () => void }) {
  const theme = useAppTheme();
  const colors: PreviewColors = mode === "light"
    ? { background: "#f7f7f5", surface: "#ffffff", surfaceRaised: "#eceeea", border: "#d9ddd7", accent: "#b85427", text: "#1d2024", textMuted: "#68717a" }
    : pureBlack
      ? { background: "#000000", surface: "#070809", surfaceRaised: "#15171a", border: "#25292f", accent: "#f08349", text: "#f7f8fa", textMuted: "#a2aab6" }
      : { background: "#0f1114", surface: "#171a1f", surfaceRaised: "#22262e", border: "#2d333c", accent: "#f08349", text: "#f7f8fa", textMuted: "#a2aab6" };
  return (
    <View style={{ width }}>
      <Pressable
        accessibilityRole="radio"
        accessibilityLabel={`${label} theme`}
        accessibilityState={{ selected, checked: selected }}
        aria-checked={selected}
        onPress={onPress}
        android_ripple={{ color: theme.colors.pressOverlay }}
        style={({ pressed }) => ({
          width,
          aspectRatio: 0.62,
          padding: 4,
          borderRadius: 17,
          borderWidth: selected ? 3 : 1,
          borderColor: selected ? theme.colors.accent : colors.border,
          backgroundColor: colors.background,
          opacity: pressed ? 0.82 : 1,
        })}
      >
        <View style={{ flex: 1, borderRadius: 12, overflow: "hidden", backgroundColor: colors.background }}>
          <View style={{ height: 30, paddingHorizontal: 7, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.surface }}>
            <View style={{ width: "54%", height: 5, borderRadius: 3, backgroundColor: colors.text, opacity: 0.85 }} />
            <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: selected ? colors.accent : colors.surfaceRaised }} />
          </View>
          <View style={{ flex: 1, padding: 8 }}>
            <View style={{ width: "72%", height: 5, borderRadius: 3, backgroundColor: colors.textMuted, opacity: 0.8 }} />
            <View style={{ width: "48%", height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: 6 }} />
            <View style={{ width: "58%", height: 34, borderRadius: 7, backgroundColor: colors.surfaceRaised, marginTop: 13 }} />
          </View>
          <View style={{ height: 30, paddingHorizontal: 7, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.surface }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.accent }} />
            <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: colors.textMuted, opacity: 0.65 }} />
          </View>
        </View>
      </Pressable>
      <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textSecondary, textAlign: "center", marginTop: 8 }]}>{label}</Text>
    </View>
  );
}

const styles = {
  intro: { paddingHorizontal: 16, paddingTop: 22, paddingBottom: 4 },
  segmented: { minHeight: 48, borderWidth: 1, borderRadius: 24, flexDirection: "row" as const, overflow: "hidden" as const },
  segment: { flex: 1, minHeight: 46, paddingHorizontal: 8, flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 6 },
  group: { borderWidth: 1, borderRadius: 14, overflow: "hidden" as const },
  settingRow: { minHeight: 72, paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row" as const, alignItems: "center" as const, gap: 11, borderBottomWidth: 1 },
  settingIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center" as const, justifyContent: "center" as const },
  settingText: { flex: 1, minWidth: 0 },
  currentPalette: { padding: 14, borderWidth: 1, borderRadius: 13 },
} satisfies Record<string, object>;
