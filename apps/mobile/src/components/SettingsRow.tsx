import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { typography, useAppTheme } from "@/src/theme";
import { AppIcon, type IconName } from "@/src/ui";

export function SettingsRow({ icon, title, value, children, onPress, disabled = false, danger = false }: {
  icon: IconName;
  title: string;
  value?: string;
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const theme = useAppTheme();
  const content = <>
    <AppIcon name={icon} size={20} color={danger ? theme.colors.danger : theme.colors.textMuted} />
    <View style={{ flex: 1, minWidth: 0, gap: theme.spacing.xs }}>
      <Text style={[typography.body, { color: danger ? theme.colors.danger : theme.colors.text }]}>{title}</Text>
      {value ? <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{value}</Text> : null}
    </View>
    {children}
    {onPress ? <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} /> : null}
  </>;
  const style = {
    minHeight: 56,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  };
  return onPress ? <Pressable
    accessibilityRole="button"
    accessibilityLabel={title}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [style, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface, opacity: disabled ? 0.55 : 1 }]}
  >{content}</Pressable> : <View style={[style, { backgroundColor: theme.colors.surface }]}>{content}</View>;
}
