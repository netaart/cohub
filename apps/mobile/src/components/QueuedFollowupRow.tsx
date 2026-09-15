import type { RefObject } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useTranslation } from "@/src/i18n";
import { typography, useAppTheme } from "@/src/theme";

export function QueuedFollowupRow({ preview, pending, hidden = false, surfaceHidden = false, rowRef, onSteer, onCancel }: {
  preview: string;
  pending: boolean;
  hidden?: boolean;
  surfaceHidden?: boolean;
  rowRef?: RefObject<View | null>;
  onSteer?: () => void;
  onCancel?: () => void;
}) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return <Animated.View ref={rowRef} collapsable={false} testID="chat-queue-item" pointerEvents={hidden ? "none" : "auto"} accessibilityElementsHidden={hidden} importantForAccessibility={hidden ? "no-hide-descendants" : "auto"} style={[styles.row, { opacity: hidden ? 0 : 1, backgroundColor: surfaceHidden ? "transparent" : theme.colors.surface }]}>
    <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.text, flex: 1, minWidth: 0 }]}>{preview}</Text>
    {pending ? <ActivityIndicator accessibilityLabel={t("chat.sending")} size="small" color={theme.colors.accent} /> : <>
      <Pressable accessibilityRole="button" accessibilityLabel={t("chat.steerAccessibility", { preview })} onPress={onSteer} style={({ pressed }) => [styles.action, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.accentSoft }]}><Text style={[typography.caption, { color: theme.colors.accent }]}>{t("chat.steerNow")}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t("chat.cancelFollowup", { preview })} onPress={onCancel} style={({ pressed }) => [styles.action, { backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}><Text style={[typography.caption, { color: theme.colors.textMuted }]}>{t("common.cancel")}</Text></Pressable>
    </>}
  </Animated.View>;
}

const styles = StyleSheet.create({
  row: { width: "100%", minHeight: 54, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10, paddingLeft: 10, paddingRight: 6, paddingVertical: 5 },
  action: { minHeight: 44, paddingHorizontal: 8, paddingVertical: 5, justifyContent: "center", borderRadius: 8 },
});
