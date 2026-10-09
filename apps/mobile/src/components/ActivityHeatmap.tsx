import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import type { SpaceUsageHourlyStat } from "@neta-art/cohub";
import { useAppTheme, typography } from "@/src/theme";
import { localDateKey } from "@/src/data/activity";
import { useTranslation } from "@/src/i18n";

type HeatmapProps = {
  hourly: SpaceUsageHourlyStat[];
  days: number;
};

const LEGEND_CELL_SIZE = 11;
const CELL_GAP = 3;
const DAYS_IN_WEEK = 7;

export const ActivityHeatmap = memo(function ActivityHeatmap({ hourly, days }: HeatmapProps) {
  const theme = useAppTheme();
  const { t, locale } = useTranslation();

  const { grid, maxValue, weeks } = useMemo(() => {
    // Aggregate hourly data to daily totals
    const dailyMap = new Map<string, number>();
    
    for (const stat of hourly) {
      const date = new Date(stat.bucketStartAt);
      const dateKey = localDateKey(date);
      const current = dailyMap.get(dateKey) || 0;
      dailyMap.set(dateKey, current + stat.totalTokens);
    }

    // Calculate start date (today - days)
    const endDate = new Date();
    endDate.setHours(0, 0, 0, 0);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - days + 1);
    const rangeStart = new Date(startDate);

    // Adjust to start on Sunday
    const startDay = startDate.getDay();
    if (startDay !== 0) {
      startDate.setDate(startDate.getDate() - startDay);
    }

    // Build grid data
    const grid: { value: number; date: Date; isEmpty: boolean }[] = [];
    let maxValue = 0;
    const currentDate = new Date(startDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Calculate total cells needed (round up to full weeks)
    const totalDays = days + rangeStart.getDay();
    const totalWeeks = Math.ceil(totalDays / DAYS_IN_WEEK);

    for (let i = 0; i < totalWeeks * DAYS_IN_WEEK; i++) {
      const dateKey = localDateKey(currentDate);
      const value = dailyMap.get(dateKey) || 0;
      const isEmpty = currentDate < rangeStart || currentDate > today;
      
      if (value > maxValue && !isEmpty) maxValue = value;
      grid.push({ value, date: new Date(currentDate), isEmpty });
      
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return { grid, maxValue, weeks: totalWeeks };
  }, [hourly, days]);

  const getColor = (intensity: number, isEmpty = false) => {
    if (isEmpty) return "transparent";
    if (intensity === 0) return theme.colors.border;
    
    // GitHub-style color scale with better contrast
    if (intensity < 0.25) return `${theme.colors.accent}33`; // 20%
    if (intensity < 0.5) return `${theme.colors.accent}66`;  // 40%
    if (intensity < 0.75) return `${theme.colors.accent}99`; // 60%
    if (intensity < 0.9) return `${theme.colors.accent}cc`;  // 80%
    return theme.colors.accent; // 100%
  };

  const weekdayFormatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const weekdays = Array.from({ length: DAYS_IN_WEEK }, (_, day) => weekdayFormatter.format(new Date(2024, 0, 7 + day)));
  const cellColor = (cell: (typeof grid)[number]) => getColor(maxValue > 0 ? cell.value / maxValue : 0, cell.isEmpty);

  return (
    <View style={{ alignSelf: "stretch", gap: theme.spacing.sm }}>
      <Text style={[typography.caption, { color: theme.colors.textMuted }]}>
        {t("activity.heatmap.range", { days })}
      </Text>

      {/* A short range reads left-to-right; stretching one week-column would make a seven-screen-tall grid. */}
      {days <= DAYS_IN_WEEK ? <View testID="activity-heatmap-week" style={{ flexDirection: "row", gap: CELL_GAP }}>
        {grid.filter((cell) => !cell.isEmpty).map((cell) => <View key={localDateKey(cell.date)} style={{ flex: 1, minWidth: 0, gap: theme.spacing.xs }}>
          <Text numberOfLines={1} style={[typography.micro, { color: theme.colors.textFaint, textAlign: "center" }]}>{weekdays[cell.date.getDay()]}</Text>
          <View accessible accessibilityLabel={`${localDateKey(cell.date)}: ${cell.value.toLocaleString()} tokens`} style={{ aspectRatio: 1, borderRadius: 3, backgroundColor: cellColor(cell) }} />
        </View>)}
      </View> : <View style={{ flexDirection: "row", gap: theme.spacing.sm }}>
        <View style={{ gap: CELL_GAP }}>
          {weekdays.map((label, index) => <View key={index} style={{ flex: 1, justifyContent: "center" }}>
            <Text numberOfLines={1} style={[typography.micro, { color: theme.colors.textFaint }]}>{index % 2 === 1 ? label : ""}</Text>
          </View>)}
        </View>
        <View testID="activity-heatmap-grid" style={{ flex: 1, minWidth: 0, flexDirection: "row", gap: CELL_GAP }}>
          {Array.from({ length: weeks }, (_, weekIdx) => <View key={weekIdx} style={{ flex: 1, minWidth: 0, gap: CELL_GAP }}>
            {grid.slice(weekIdx * DAYS_IN_WEEK, (weekIdx + 1) * DAYS_IN_WEEK).map((cell) => <View
              key={localDateKey(cell.date)}
              accessible={!cell.isEmpty}
              accessibilityLabel={cell.isEmpty ? undefined : `${localDateKey(cell.date)}: ${cell.value.toLocaleString()} tokens`}
              style={{ aspectRatio: 1, borderRadius: 3, backgroundColor: cellColor(cell) }}
            />)}
          </View>)}
        </View>
      </View>}

      {/* Legend */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: theme.spacing.xs }}>
        <Text style={[typography.micro, { color: theme.colors.textFaint }]}>{t("activity.heatmap.less")}</Text>
        <View style={{ flexDirection: "row", gap: 2 }}>
          {[0, 0.2, 0.4, 0.6, 0.8, 1].map((intensity) => (
            <View
              key={intensity}
              style={{
                width: LEGEND_CELL_SIZE,
                height: LEGEND_CELL_SIZE,
                borderRadius: 3,
                backgroundColor: getColor(intensity),
              }}
            />
          ))}
        </View>
        <Text style={[typography.micro, { color: theme.colors.textFaint }]}>{t("activity.heatmap.more")}</Text>
      </View>
    </View>
  );
});
