import { useMemo } from "react";
import { Text, View } from "react-native";
import type { SpaceUsageHourlyStat } from "@neta-art/cohub";
import { useAppTheme, typography } from "@/src/theme";

type HeatmapProps = {
  hourly: SpaceUsageHourlyStat[];
  days: number;
};

const HOURS_PER_DAY = 24;
const CELL_SIZE = 12;
const CELL_GAP = 2;

export function ActivityHeatmap({ hourly, days }: HeatmapProps) {
  const theme = useAppTheme();

  const { grid, maxValue, totalDays } = useMemo(() => {
    // Calculate total days to show (round up to full weeks for visual alignment)
    const totalDays = Math.ceil(days / 7) * 7;
    
    // Create a map of timestamp to stat
    const statMap = new Map<string, SpaceUsageHourlyStat>();
    for (const stat of hourly) {
      statMap.set(stat.bucketStartAt, stat);
    }

    // Find the latest timestamp
    const now = new Date();
    const endDate = new Date(now);
    endDate.setHours(0, 0, 0, 0);

    // Build grid data (days × hours)
    const grid: { value: number; date: Date }[] = [];
    let maxValue = 0;

    for (let dayOffset = totalDays - 1; dayOffset >= 0; dayOffset--) {
      const date = new Date(endDate);
      date.setDate(date.getDate() - dayOffset);

      for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
        const hourDate = new Date(date);
        hourDate.setHours(hour, 0, 0, 0);
        const isoString = hourDate.toISOString();

        const stat = statMap.get(isoString);
        const value = stat ? stat.totalTokens : 0;
        
        if (value > maxValue) maxValue = value;
        grid.push({ value, date: hourDate });
      }
    }

    return { grid, maxValue, totalDays };
  }, [hourly, days]);

  const getColor = (value: number) => {
    if (value === 0) return theme.colors.surfaceRaised;
    
    const intensity = Math.min(1, value / maxValue);
    
    // Use a more vibrant color scale
    if (intensity < 0.25) return theme.colors.accentSoft;
    if (intensity < 0.5) return `${theme.colors.accent}40`;
    if (intensity < 0.75) return `${theme.colors.accent}80`;
    return theme.colors.accent;
  };

  const weeks = Math.ceil(totalDays / 7);
  const cellWithGap = CELL_SIZE + CELL_GAP;

  return (
    <View style={{ gap: 8 }}>
      <Text style={[typography.caption, { color: theme.colors.textMuted }]}>
        Activity heatmap (last {days} days)
      </Text>
      
      <View style={{ flexDirection: "row", gap: 16 }}>
        {/* Day labels */}
        <View style={{ justifyContent: "space-around", height: HOURS_PER_DAY * cellWithGap - CELL_GAP, paddingVertical: 2 }}>
          {["12am", "6am", "12pm", "6pm"].map((label) => (
            <Text key={label} style={[typography.micro, { color: theme.colors.textFaint, fontSize: 9, lineHeight: 12 }]}>
              {label}
            </Text>
          ))}
        </View>

        {/* Heatmap grid */}
        <View style={{ flexDirection: "row", gap: CELL_GAP }}>
          {Array.from({ length: weeks }).map((_, weekIdx) => (
            <View key={weekIdx} style={{ gap: CELL_GAP }}>
              {Array.from({ length: HOURS_PER_DAY }).map((_, hourIdx) => {
                const cellIdx = weekIdx * HOURS_PER_DAY + hourIdx;
                const cell = grid[cellIdx];
                if (!cell) return null;

                return (
                  <View
                    key={hourIdx}
                    style={{
                      width: CELL_SIZE,
                      height: CELL_SIZE,
                      borderRadius: 2,
                      backgroundColor: getColor(cell.value),
                    }}
                  />
                );
              })}
            </View>
          ))}
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
                backgroundColor: getColor(intensity * maxValue),
              }}
            />
          ))}
        </View>
        <Text style={[typography.micro, { color: theme.colors.textFaint, fontSize: 9 }]}>More</Text>
      </View>
    </View>
  );
}
