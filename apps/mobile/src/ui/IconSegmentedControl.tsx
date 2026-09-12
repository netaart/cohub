import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AppIcon, type IconName } from "@/src/ui";
import { typography, useAppTheme } from "@/src/theme";

type Segment<Value extends string> = {
  value: Value;
  icon: IconName;
  label: string;
};

type IconSegmentedControlProps<Value extends string> = {
  value: Value;
  options: readonly Segment<Value>[];
  onChange: (value: Value) => void;
};

export function IconSegmentedControl<Value extends string>({ value, options, onChange }: IconSegmentedControlProps<Value>) {
  const theme = useAppTheme();
  const [hint, setHint] = useState<string | null>(null);
  return (
    <View style={styles.control}>
      <View accessibilityRole="tablist" style={styles.segments}>
        {options.map((option) => {
          const selected = option.value === value;
          return <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => { setHint(null); onChange(option.value); }}
            onLongPress={() => setHint(option.label)}
            onPressOut={() => setHint(null)}
            onHoverIn={() => setHint(option.label)}
            onHoverOut={() => setHint(null)}
            style={({ pressed }) => [styles.segment, { backgroundColor: pressed ? theme.colors.surfacePressed : selected ? theme.colors.accentSoft : "transparent" }]}
          >
            <AppIcon name={option.icon} size={20} color={selected ? theme.colors.accent : theme.colors.textMuted} />
            {selected ? <View style={[styles.indicator, { backgroundColor: theme.colors.accent }]} /> : null}
          </Pressable>;
        })}
      </View>
      {hint ? <View pointerEvents="none" style={[styles.hint, { backgroundColor: theme.colors.text }]}>
        <Text style={[typography.caption, { textAlign: "center", color: theme.colors.background }]}>{hint}</Text>
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  control: { alignSelf: "flex-start", maxWidth: "100%", zIndex: 1 },
  segments: { flexDirection: "row", gap: 4 },
  segment: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  indicator: { position: "absolute", bottom: 4, width: 12, height: 2, borderRadius: 1 },
  hint: { position: "absolute", top: 52, left: 0, right: 0, padding: 8, borderRadius: 8, zIndex: 1, elevation: 4 },
});
