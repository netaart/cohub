import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import type { SpaceUsageHourlyStat } from "@neta-art/cohub";
import { useAppTheme, typography } from "@/src/theme";

type HeatmapProps = {
  hourly: SpaceUsageHourlyStat[];
  days: number;
};

const CELL_SIZE = 10;
const CELL_GAP = 2;
const DAYS_IN_WEEK = 7;

export const ActivityHeatmap = memo(function ActivityHeatmap({ hourly, days }: HeatmapProps) {
  const theme = useAppTheme();

  const { grid, maxValue, weeks } = useMemo(() => {
    // Aggregate hourly data to daily totals
    const dailyMap = new Map<string, number>();
    
    for (const stat of hourly) {
      const date = new Date(stat.bucketStartAt);
      const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD
      const current = dailyMap.get(dateKey) || 0;
      dailyMap.set(dateKey, current + stat.totalTokens);
    }

    // Calculate start date (today - days)
    const endDate = new Date();
    endDate.setHours(0, 0, 0, 0);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - days + 1);

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
    const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const totalWeeks = Math.ceil(totalDays / DAYS_IN_WEEK);

    for (let i = 0; i < totalWeeks * DAYS_IN_WEEK; i++) {
      const dateKey = currentDate.toISOString().split('T')[0];
      const value = dailyMap.get(dateKey) || 0;
      const isEmpty = currentDate < startDate || currentDate > today;
      
      if (value > maxValue && !isEmpty) maxValue = value;
      grid.push({ value, date: new Date(currentDate), isEmpty });
      
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return { grid, maxValue, weeks: totalWeeks };
  }, [hourly, days]);

  const getColor = (value: number, isEmpty: boolean) => {
    if (isEmpty || value === 0) return theme.colors.surfaceRaised;
    
    const intensity = maxValue > 0 ? value / maxValue : 0;
    
    // GitHub-style 5-level color scale
    if (intensity < 0.2) return theme.colors.accentSoft;
    if (intensity < 0.4) return `${theme.colors.accent}60`;
    if (intensity < 0.6) return `${theme.colors.accent}80`;
    if (intensity < 0.8) return `${theme.colors.accent}cc`;
    return theme.colors.accent;
  };

  const cellWithGap = CELL_SIZE + CELL_GAP;
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <View style={{ gap: 8 }}>
      <Text style={[typography.caption, { color: theme.colors.textMuted }]}>(
        Activity over the last {days} days
      </Text>
      
      <View style={{ flexDirection: "row", gap: 8 }}>
        {/* Weekday labels */}
        <View style={{ justifyContent: "space-between", height: DAYS_IN_WEEK * cellWithGap - CELL_GAP, paddingTop: 16 }}>
          {[1, 3, 5].map((idx) => (
            <Text key={idx} style={[typography.micro, { color: theme.colors.textFaint, fontSize: 9, lineHeight: 10 }]}>
              {weekdays[idx]}
            </Text>
          ))}
        </View>

        {/* Heatmap grid (weeks × days) */}
        <View>
          <View style={{ flexDirection: "row", gap: CELL_GAP }}>
            {Array.from({ length: weeks }).map((_, weekIdx) => (
              <View key={weekIdx} style={{ gap: CELL_GAP }}>
                {Array.from({ length: DAYS_IN_WEEK }).map((_, dayIdx) => {
                  const cellIdx = weekIdx * DAYS_IN_WEEK + dayIdx;
                  const cell = grid[cellIdx];
                  if (!cell) return null;

                  return (
                    <View
                      key={dayIdx}
                      style={{
                        width: CELL_SIZE,
                        height: CELL_SIZE,
                        borderRadius: 2,
                        backgroundColor: getColor(cell.value, cell.isEmpty),
                      }}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        </View>
      </View>

      {/* Legend */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
        <Text style={[typography.micro, { color: theme.colors.textFaint, fontSize: 9 }]}>Less</Text>
        <View style={{ flexDirection: "row", gap: 2 }}>
          {[0, 0.2, 0.4, 0.6, 0.8, 1].map((intensity) => (
            <View
              key={intensity}
              style={{
                width: CELL_SIZE,
                height: CELL_SIZE,
                borderRadius: 2,
                backgroundColor: getColor(intensity * (maxValue || 1), false),
              }}
            />
          ))}
        </View>
        <Text style={[typography.micro, { color: theme.colors.textFaint, fontSize: 9 }]}>More</Text>
      </View>
    </View>
  );
});
