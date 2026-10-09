import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, type IconName } from "@/src/ui";

const MIN_MENU_WIDTH = 180;
const MAX_MENU_WIDTH = 280;
const ROW_HEIGHT = 48;

export type ContextMenuAction = {
  icon: IconName;
  title: string;
  onPress: () => void;
};

export function ContextMenu({
  visible,
  x,
  y,
  actions,
  onClose,
  testID,
}: {
  visible: boolean;
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
  testID?: string;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const menuHeight = actions.length * ROW_HEIGHT + 8;
  const contentWidth = Math.max(...actions.map((action) => Array.from(action.title).length * 9 + 14 * 2 + 18 + 10), 0);
  const menuWidth = Math.min(width - 24, Math.max(MIN_MENU_WIDTH, Math.min(MAX_MENU_WIDTH, contentWidth)));
  const left = Math.min(Math.max(12, x - menuWidth / 2), Math.max(12, width - menuWidth - 12));
  const top = Math.min(
    Math.max(insets.top + 8, y - menuHeight - 16),
    Math.max(insets.top + 8, height - insets.bottom - menuHeight - 12),
  );

  return <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
    <View style={styles.overlay} testID={testID}>
      <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={onClose} />
      <View accessibilityRole="menu" style={[styles.menu, { top, left, width: menuWidth, backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border, shadowColor: theme.colors.shadow }]}>
        {actions.map((action) => (
          <Pressable
            key={action.title}
            accessibilityRole="menuitem"
            accessibilityLabel={action.title}
            onPress={() => {
              onClose();
              action.onPress();
            }}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}
          >
            <AppIcon name={action.icon} size={18} color={theme.colors.textSecondary} />
            <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{action.title}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
  },
  menu: {
    position: "absolute",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingVertical: 4,
    overflow: "hidden",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 16,
    elevation: 8,
  },
  row: {
    minHeight: ROW_HEIGHT,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
});
