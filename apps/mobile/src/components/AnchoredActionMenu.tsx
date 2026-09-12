import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "expo-router";
import { AppIcon, type IconName } from "@/src/ui";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { getAnchoredMenuLayout } from "@/src/ui/anchored-menu-layout";

export type AnchoredMenuAction = {
  icon: IconName;
  title: string;
  disabled?: boolean;
  onPress: () => void;
};

type AnchoredActionMenuProps = {
  anchorRef: RefObject<View | null>;
  title: string;
  actions: readonly AnchoredMenuAction[];
  onClose: () => void;
  testID: string;
};

export function AnchoredActionMenu({ anchorRef, title, actions, onClose, testID }: AnchoredActionMenuProps) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const focused = useIsFocused();
  const overlayRef = useRef<View>(null);
  const [layout, setLayout] = useState<ReturnType<typeof getAnchoredMenuLayout> | null>(null);
  const measure = useCallback(() => {
    overlayRef.current?.measureInWindow((x, y, viewportWidth, viewportHeight) => {
      anchorRef.current?.measureInWindow((anchorX, anchorY, anchorWidth, anchorHeight) => {
        setLayout(getAnchoredMenuLayout({
          anchor: { x: anchorX, y: anchorY, width: anchorWidth, height: anchorHeight },
          viewport: { x, y, width: viewportWidth, height: viewportHeight },
          bottomInset: insets.bottom,
        }));
      });
    });
  }, [anchorRef, insets.bottom]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [height, measure, width]);

  useEffect(() => {
    if (!focused) { onClose(); return; }
    const back = BackHandler.addEventListener("hardwareBackPress", () => { onClose(); return true; });
    return () => back.remove();
  }, [focused, onClose]);

  // Keep this in the screen, not a native Modal, so actions can immediately open their own surface.
  return <View ref={overlayRef} collapsable={false} onLayout={measure} style={styles.overlay}>
    <Pressable accessibilityRole="button" accessibilityLabel={t("ui.sheet.close", { title })} style={StyleSheet.absoluteFill} onPress={onClose} />
    {layout ? <View
      testID={testID}
      accessibilityViewIsModal
      accessibilityRole="menu"
      accessibilityLabel={title}
      onAccessibilityEscape={onClose}
      style={[styles.menu, layout, { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border, shadowColor: theme.colors.shadow }]}
    >
      <ScrollView style={{ flexGrow: 0 }} bounces={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.content}>
        {actions.map((action) => <Pressable
          key={action.title}
          accessibilityRole="menuitem"
          accessibilityLabel={action.title}
          accessibilityState={{ disabled: Boolean(action.disabled) }}
          disabled={action.disabled}
          onPress={() => { onClose(); action.onPress(); }}
          style={({ pressed }) => [styles.action, { opacity: action.disabled ? 0.45 : 1, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}
        >
          <AppIcon name={action.icon} size={21} color={theme.colors.textSecondary} />
          <Text style={[typography.body, styles.label, { color: theme.colors.text }]}>{action.title}</Text>
        </Pressable>)}
      </ScrollView>
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 20, elevation: 20 },
  menu: { position: "absolute", borderRadius: 14, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 12, elevation: 8 },
  content: { paddingVertical: 6 },
  action: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 14 },
  label: { flex: 1, minWidth: 0 },
});
