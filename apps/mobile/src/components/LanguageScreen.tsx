import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getDeviceLocale,
  useTranslation,
  type AppLocale,
  type LocalePreference,
} from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, TopBar, Screen, SectionHeader } from "@/src/ui";

type LocaleOption = {
  value: LocalePreference;
  labelKey: "language.option.system" | "language.option.en" | "language.option.zh";
  detailKey:
    | "language.option.systemDetail"
    | "language.option.enDetail"
    | "language.option.zhDetail";
  code: string;
};

const LOCALE_OPTIONS: LocaleOption[] = [
  {
    value: "system",
    labelKey: "language.option.system",
    detailKey: "language.option.systemDetail",
    code: "A",
  },
  {
    value: "en",
    labelKey: "language.option.en",
    detailKey: "language.option.enDetail",
    code: "EN",
  },
  {
    value: "zh",
    labelKey: "language.option.zh",
    detailKey: "language.option.zhDetail",
    code: "中",
  },
];

export function LanguageScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  return (
    <Screen>
      <TopBar
        title={t("language.title")}
        onBack={() => router.back()}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <LanguageContent />
      </ScrollView>
    </Screen>
  );
}

export function LanguageContent() {
  const theme = useAppTheme();
  const { t, preference, setPreference } = useTranslation();

  return (
    <View testID="language-content">
      <View style={styles.intro}>
        <Text style={[typography.title, { color: theme.colors.text }]}>
          {t("language.intro.title")}
        </Text>
        <Text
          style={[
            typography.body,
            { color: theme.colors.textMuted, marginTop: 6, maxWidth: 520 },
          ]}
        >
          {t("language.intro.body")}
        </Text>
      </View>

      <SectionHeader title={t("language.section.app")} />
      <View style={[styles.group, { marginHorizontal: 16, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        {LOCALE_OPTIONS.map((option, index) => {
          const selected = preference === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={t(option.labelKey)}
              accessibilityState={{ selected, checked: selected }}
              aria-checked={selected}
              onPress={() => void setPreference(option.value)}
              style={({ pressed }) => [
                styles.row,
                index > 0
                  ? { borderTopWidth: 1, borderTopColor: theme.colors.border }
                  : null,
                {
                  backgroundColor: selected
                    ? theme.colors.accentSoft
                    : pressed
                      ? theme.colors.surfacePressed
                      : "transparent",
                },
              ]}
            >
              <View
                style={[
                  styles.code,
                  {
                    backgroundColor: selected
                      ? theme.colors.accent
                      : theme.colors.surfaceRaised,
                  },
                ]}
              >
                <Text
                  style={[
                    typography.caption,
                    {
                      color: selected
                        ? theme.colors.accentText
                        : theme.colors.textMuted,
                    },
                  ]}
                >
                  {option.code}
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={[
                    typography.bodyMedium,
                    {
                      color: selected ? theme.colors.accent : theme.colors.text,
                    },
                  ]}
                >
                  {t(option.labelKey)}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[
                    typography.caption,
                    { color: theme.colors.textMuted, marginTop: 2 },
                  ]}
                >
                  {t(option.detailKey)}
                </Text>
              </View>
              {selected ? (
                <AppIcon name="check" size={18} color={theme.colors.accent} />
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.group, { marginTop: 16, marginHorizontal: 16, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <View style={[styles.row, { borderTopWidth: 0 }]}>
          <View style={[styles.code, { backgroundColor: theme.colors.surfaceRaised }]}>
            <AppIcon name="globe" size={17} color={theme.colors.textMuted} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>
              {t("language.device.title")}
            </Text>
            <Text
              numberOfLines={1}
              style={[
                typography.caption,
                { color: theme.colors.textMuted, marginTop: 2 },
              ]}
            >
              {deviceLocaleLabel(getDeviceLocale(), t)}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function deviceLocaleLabel(
  deviceLocale: AppLocale,
  t: (key: "language.device.english" | "language.device.chinese") => string,
): string {
  return deviceLocale === "zh"
    ? t("language.device.chinese")
    : t("language.device.english");
}

const styles = {
  intro: { paddingHorizontal: 16, paddingTop: 22, paddingBottom: 4 },
  group: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden" as const,
  },
  row: {
    minHeight: 68,
    paddingHorizontal: 13,
    paddingVertical: 10,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 11,
  },
  code: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
} satisfies Record<string, object>;
