import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { Keyboard, Modal, Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "@/src/i18n";
import { useAppTheme } from "@/src/theme";
import { getComposerMenuLayout, type ComposerMenuAnchor } from "@/src/ui/composer-menu-layout";

export type ComposerMenuProps = {
  anchorRef: RefObject<View | null>;
  title: string;
  onClose: () => void;
  children: ReactNode;
  preferredWidth: number;
  fillHeight?: boolean;
  testID: string;
};

export function ComposerMenu({ anchorRef, title, onClose, children, preferredWidth, fillHeight = false, testID }: ComposerMenuProps) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [viewport, setViewport] = useState({ width, height });
  const [keyboardTop, setKeyboardTop] = useState<number | null>(() => Keyboard.metrics()?.screenY ?? null);
  const [anchor, setAnchor] = useState<ComposerMenuAnchor | null>(null);
  const measureAnchor = useCallback(() => {
    anchorRef.current?.measureInWindow((x, y, anchorWidth, anchorHeight) => {
      setAnchor({ x, y, width: anchorWidth, height: anchorHeight });
    });
  }, [anchorRef]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measureAnchor);
    return () => cancelAnimationFrame(frame);
  }, [height, keyboardTop, measureAnchor, viewport.height, viewport.width, width]);

  useEffect(() => {
    // The composer moves when its keyboard closes or the model search keyboard opens.
    const frameEvent = Platform.OS === "ios" ? "keyboardDidChangeFrame" : "keyboardDidShow";
    const frame = Keyboard.addListener(frameEvent, (event) => setKeyboardTop(event.endCoordinates.screenY));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardTop(null));
    return () => { frame.remove(); hide.remove(); };
  }, []);

  const layout = anchor ? getComposerMenuLayout({ anchor, windowWidth: viewport.width, windowHeight: viewport.height, topInset: insets.top, bottomInset: keyboardTop === null ? insets.bottom : 0, keyboardTop, preferredWidth }) : null;
  return <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent hardwareAccelerated onShow={measureAnchor} onRequestClose={onClose}>
    <View style={styles.overlay} onLayout={(event) => setViewport({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("ui.sheet.close", { title })} style={StyleSheet.absoluteFill} onPress={onClose} />
      {layout ? <View
        testID={testID}
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        accessibilityLabel={title}
        role="dialog"
        style={[styles.panel, layout, { height: fillHeight ? layout.maxHeight : undefined, backgroundColor: theme.colors.surface, borderColor: theme.colors.borderStrong, shadowColor: theme.colors.shadow }]}
      >{children}</View> : null}
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1 },
  panel: { position: "absolute", minHeight: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, borderCurve: "continuous", overflow: "hidden", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 12, elevation: 8 },
});
