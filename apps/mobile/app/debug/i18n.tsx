import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { getDeviceLocale, useTranslation, type LocalePreference } from "@/src/i18n";
import { en } from "@/src/i18n/en";
import { zh } from "@/src/i18n/zh";
import { typography, useAppTheme } from "@/src/theme";
import { Screen, SectionHeader } from "@/src/ui";

const PREFERENCES: LocalePreference[] = ["system", "en", "zh"];
const LIMIT = 120;

export default function DebugI18nScreen() {
  const theme = useAppTheme();
  const { t, locale, preference, setPreference } = useTranslation();
  const [query, setQuery] = useState("");

  const keys = useMemo(() => Object.keys(en).sort() as (keyof typeof en)[], []);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? keys.filter((key) => key.toLowerCase().includes(needle) || en[key].toLowerCase().includes(needle) || zh[key].toLowerCase().includes(needle))
      : keys;
    return filtered.slice(0, LIMIT);
  }, [keys, query]);

  const missing = useMemo(() => keys.filter((key) => !zh[key]), [keys]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <SectionHeader title="当前语言" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <Row label="locale" value={locale} />
          <Row label="preference" value={preference} />
          <Row label="device" value={getDeviceLocale()} />
          <Row label="keys" value={`${keys.length}（缺失 ${missing.length}）`} />
        </View>

        <SectionHeader title="切换" />
        <View style={{ paddingHorizontal: 16, flexDirection: "row", gap: 8 }}>
          {PREFERENCES.map((option) => (
            <Pressable
              key={option}
              accessibilityRole="tab"
              accessibilityState={{ selected: preference === option }}
              onPress={() => void setPreference(option)}
              style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 13, borderRadius: 999, justifyContent: "center", borderWidth: 1, borderColor: preference === option ? theme.colors.accentBorder : theme.colors.border, backgroundColor: preference === option ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface })}
            >
              <Text style={[typography.caption, { color: preference === option ? theme.colors.accent : theme.colors.textMuted }]}>{option}</Text>
            </Pressable>
          ))}
          <View style={{ flex: 1 }} />
          <Text style={[typography.micro, { color: theme.colors.textFaint, alignSelf: "center" }]}>{`t("common.retry") = ${t("common.retry")}`}</Text>
        </View>

        <SectionHeader title="Key 检索" />
        <View style={{ paddingHorizontal: 16 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索 key 或中英文文案"
            placeholderTextColor={theme.colors.textFaint}
            autoCapitalize="none"
            style={[typography.body, { color: theme.colors.text, minHeight: 46, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.background }]}
          />
        </View>
        <View style={[styles.group, { marginTop: 12, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          {matches.length === 0 ? (
            <Text style={[typography.caption, { color: theme.colors.textMuted, padding: 14 }]}>没有匹配的 key</Text>
          ) : matches.map((key) => (
            <View key={key} style={{ paddingHorizontal: 13, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: theme.colors.border, gap: 3 }}>
              <Text selectable style={[typography.micro, { color: theme.colors.accent, fontFamily: "SpaceMono" }]}>{key}</Text>
              <Text selectable style={[typography.caption, { color: theme.colors.textSecondary }]}>{en[key]}</Text>
              <Text selectable style={[typography.caption, { color: theme.colors.textMuted }]}>{zh[key]}</Text>
            </View>
          ))}
          {matches.length >= LIMIT ? (
            <Text style={[typography.micro, { color: theme.colors.textFaint, padding: 12 }]}>仅显示前 {LIMIT} 条，请继续输入缩小范围</Text>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const theme = useAppTheme();
  return (
    <View style={{ minHeight: 50, paddingHorizontal: 13, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <Text style={[typography.caption, { color: theme.colors.textMuted, width: 110 }]}>{label}</Text>
      <Text selectable style={[typography.caption, { color: theme.colors.text, flex: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

const styles = {
  group: { marginHorizontal: 16, borderWidth: 1, borderRadius: 14, overflow: "hidden" as const },
} satisfies Record<string, object>;
