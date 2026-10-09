import type { ComponentProps } from "react";
import { Pressable, Text, View } from "react-native";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon } from "@/src/ui";

type FilterChipProps = {
  label: string;
  icon?: ComponentProps<typeof AppIcon>["name"];
  selected: boolean;
  onPress: () => void;
};

export function FilterChip({ label, icon, selected, onPress }: FilterChipProps) {
  const theme = useAppTheme();
  const color = selected ? theme.colors.accent : theme.colors.textMuted;

  // The compact capsule sits inside a full-sized touch target and can grow with text.
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{ minHeight: 48, minWidth: 48, paddingVertical: theme.spacing.sm, justifyContent: "center" }}
    >
      {({ pressed }) => (
        <View
          style={{
            minHeight: 32,
            paddingVertical: theme.spacing.xs,
            paddingHorizontal: theme.spacing.md,
            borderRadius: theme.radius.pill,
            overflow: "hidden",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: theme.spacing.xs,
            backgroundColor: pressed ? theme.colors.surfacePressed : selected ? theme.colors.accentSoft : "transparent",
          }}
        >
          {icon ? <AppIcon name={icon} size={13} color={color} /> : null}
          <Text style={[typography.caption, { fontWeight: "600", color }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}
