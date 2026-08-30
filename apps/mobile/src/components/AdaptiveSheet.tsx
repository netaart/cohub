import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, IconButton, type IconName } from "@/src/ui";

const COMPACT_BREAKPOINT = 720;
const OPEN_DURATION_MS = 220;
const CLOSE_DURATION_MS = 170;
const USE_NATIVE_DRIVER = Platform.OS !== "web";
const WEB_DRAG_STYLE: (ViewStyle & { touchAction: "none" }) | undefined =
  Platform.OS === "web" ? { touchAction: "none" } : undefined;

type AdaptiveSheetProps = {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  scrollable?: boolean;
  dismissible?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

export function AdaptiveSheet({
  visible,
  title,
  subtitle,
  onClose,
  children,
  footer,
  scrollable = true,
  dismissible = true,
  contentStyle,
  testID,
}: AdaptiveSheetProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const compact = Platform.OS === "web"
    ? width < COMPACT_BREAKPOINT
    : Math.min(width, height) < COMPACT_BREAKPOINT;
  const [progress] = useState(() => new Animated.Value(0));
  const [dragOffset] = useState(() => new Animated.Value(0));
  const hiddenOffset = Math.min(height * 0.56, 520);

  const requestClose = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  const restorePanel = useCallback(() => {
    Animated.spring(dragOffset, {
      toValue: 0,
      damping: 24,
      stiffness: 260,
      mass: 0.9,
      useNativeDriver: USE_NATIVE_DRIVER,
    }).start();
  }, [dragOffset]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          compact &&
          dismissible &&
          gesture.dy > 6 &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_, gesture) => {
          dragOffset.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > 88 || gesture.vy > 0.85) {
            Animated.timing(dragOffset, {
              toValue: height,
              duration: CLOSE_DURATION_MS,
              useNativeDriver: USE_NATIVE_DRIVER,
            }).start(({ finished }) => {
              if (finished) requestClose();
            });
            return;
          }
          restorePanel();
        },
        onPanResponderTerminate: restorePanel,
        onPanResponderTerminationRequest: () => false,
      }),
    [compact, dismissible, dragOffset, height, requestClose, restorePanel],
  );

  useEffect(() => {
    progress.stopAnimation();
    dragOffset.stopAnimation();
    dragOffset.setValue(0);

    if (!visible) {
      progress.setValue(0);
      return;
    }

    const frame = requestAnimationFrame(() => {
      Animated.timing(progress, {
        toValue: 1,
        duration: OPEN_DURATION_MS,
        useNativeDriver: USE_NATIVE_DRIVER,
      }).start();
    });

    return () => cancelAnimationFrame(frame);
  }, [dragOffset, progress, visible]);

  const backdropOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.56],
  });
  const revealOffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [hiddenOffset, 0],
  });
  const desktopOffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [14, 0],
  });
  const desktopScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.98, 1],
  });
  const animatedPanelStyle = compact
    ? {
        opacity: progress,
        transform: [{ translateY: Animated.add(revealOffset, dragOffset) }],
      }
    : {
        opacity: progress,
        transform: [{ translateY: desktopOffset }, { scale: desktopScale }],
      };
  const maxHeight = compact
    ? Math.max(0, height - insets.top - 12)
    : Math.max(0, Math.min(height - 48, 760));
  const bottomPadding = Math.max(insets.bottom, theme.spacing.lg);
  const resolvedContentStyle = [
    styles.content,
    { paddingBottom: footer ? theme.spacing.lg : bottomPadding },
    contentStyle,
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      hardwareAccelerated
      onRequestClose={requestClose}
    >
      <View style={styles.overlay} testID={testID}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable accessible={false} aria-hidden tabIndex={-1} style={styles.fill} onPress={requestClose} />
        </Animated.View>
        <KeyboardAvoidingView
          pointerEvents="box-none"
          behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "android" ? "height" : undefined}
          style={[styles.stage, compact ? styles.compactStage : styles.desktopStage]}
        >
          <Animated.View
            accessibilityViewIsModal
            role="dialog"
            style={[
              styles.panel,
              compact ? styles.compactPanel : styles.desktopPanel,
              {
                maxHeight,
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
              },
              animatedPanelStyle,
            ]}
          >
            {compact ? (
              <View
                testID={dismissible && testID ? `${testID}-drag-handle` : undefined}
                style={[styles.dragArea, WEB_DRAG_STYLE]}
                {...(dismissible ? panResponder.panHandlers : {})}
              >
                {dismissible ? <View style={[styles.dragHandle, { backgroundColor: theme.colors.borderStrong }]} /> : null}
              </View>
            ) : null}
            <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
              <View style={styles.headerText}>
                <Text accessibilityRole="header" style={[typography.heading, { color: theme.colors.text }]}>{title}</Text>
                {subtitle ? (
                  <Text style={[typography.body, { color: theme.colors.textSecondary, marginTop: 3 }]}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <IconButton
                name="x"
                label={`Close ${title}`}
                size={36}
                disabled={!dismissible}
                onPress={requestClose}
              />
            </View>
            {scrollable ? (
              <ScrollView
                style={styles.scroller}
                contentContainerStyle={resolvedContentStyle}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {children}
              </ScrollView>
            ) : (
              <View style={resolvedContentStyle}>{children}</View>
            )}
            {footer ? (
              <View
                style={[
                  styles.footer,
                  {
                    borderTopColor: theme.colors.border,
                    paddingBottom: bottomPadding,
                  },
                ]}
              >
                {footer}
              </View>
            ) : null}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

export function SheetAction({
  icon,
  title,
  detail,
  onPress,
  disabled = false,
}: {
  icon: IconName;
  title: string;
  detail?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      android_ripple={{ color: theme.colors.pressOverlay }}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: pressed ? theme.colors.surfacePressed : "transparent",
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <View style={[styles.actionIcon, { backgroundColor: theme.colors.accentSoft }]}>
        <AppIcon name={icon} size={18} color={theme.colors.accent} />
      </View>
      <View style={styles.actionText}>
        <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{title}</Text>
        {detail ? (
          <Text style={[typography.caption, { color: theme.colors.textSecondary, marginTop: 2 }]}>
            {detail}
          </Text>
        ) : null}
      </View>
      <AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
  },
  fill: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "#000000",
  },
  stage: {
    flex: 1,
    paddingHorizontal: 12,
  },
  compactStage: {
    justifyContent: "flex-end",
    paddingHorizontal: 0,
  },
  desktopStage: {
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 24,
  },
  panel: {
    width: "100%",
    minHeight: 0,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  compactPanel: {
    borderBottomWidth: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  desktopPanel: {
    maxWidth: 500,
    borderRadius: 16,
  },
  dragArea: {
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
  },
  dragHandle: {
    width: 34,
    height: 4,
    borderRadius: 2,
  },
  header: {
    minHeight: 58,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  scroller: {
    minHeight: 0,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  action: {
    minHeight: 62,
    paddingHorizontal: 8,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    overflow: "hidden",
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    flex: 1,
    minWidth: 0,
  },
});
