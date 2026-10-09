import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TokenDay } from "@/src/data/activity";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";

export function TokenHeatmap({ days }: { days: TokenDay[] }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const day = days.find((item) => item.date === selected) ?? days.at(-1);
  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, index) => days.slice(index * 7, index * 7 + 7));
  const opacity = [0, 0.25, 0.5, 0.75, 1];
  return <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm }}>
    <View style={{ flexDirection: "row", gap: theme.spacing.xs }}>
      {weeks.map((week) => <View key={week[0].date} style={{ flex: 1, gap: theme.spacing.xs }}>
        {Array.from({ length: 7 }, (_, index) => {
          const item = week[index];
          return <Pressable key={index} disabled={!item} accessibilityRole="button" accessibilityLabel={item ? `${item.date}: ${item.tokens.toLocaleString()} tokens` : undefined} accessibilityState={{ selected: item?.date === day?.date }} onPress={() => setSelected(item.date)} style={({ pressed }) => ({ aspectRatio: 1, borderRadius: 3, overflow: "hidden", backgroundColor: item ? theme.colors.surfaceRaised : "transparent", borderWidth: 1, borderColor: item?.date === day?.date ? theme.colors.text : "transparent", opacity: pressed ? 0.6 : 1 })}>
            {item && item.level > 0 ? <View style={{ flex: 1, backgroundColor: theme.colors.success, opacity: opacity[item.level] }} /> : null}
          </Pressable>;
        })}
      </View>)}
    </View>
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Text style={[typography.micro, { color: theme.colors.textMuted }]}>{days[0]?.date}</Text>
      <Text style={[typography.micro, { color: theme.colors.textMuted }]}>{days.at(-1)?.date}</Text>
    </View>
    <Text accessibilityLiveRegion="polite" style={[typography.caption, { color: theme.colors.text, minHeight: 20 }]}>{day ? `${day.date} · ${day.tokens.toLocaleString()} tokens` : ""}</Text>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: theme.spacing.xs }}>
      <Text style={[typography.micro, { color: theme.colors.textMuted }]}>{t("activity.heatmap.less")}</Text>
      {opacity.map((value, index) => <View key={index} style={{ width: 10, height: 10, borderRadius: 2, overflow: "hidden", backgroundColor: theme.colors.surfaceRaised }}><View style={{ flex: 1, backgroundColor: theme.colors.success, opacity: value }} /></View>)}
      <Text style={[typography.micro, { color: theme.colors.textMuted }]}>{t("activity.heatmap.more")}</Text>
    </View>
  </View>;
}
