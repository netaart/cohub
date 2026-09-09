import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
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
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Reanimated, { cancelAnimation, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, IconButton, type IconName } from "@/src/ui";

const COMPACT_BREAKPOINT = 720;
const OPEN_DURATION_MS = 220;

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
  fullHeight?: boolean;
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
  fullHeight = false,
  testID,
}: AdaptiveSheetProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const compact = Math.min(width, height) < COMPACT_BREAKPOINT;
  const hiddenOffset = Math.min(height * 0.56, 520);
  const progress = useSharedValue(0);
  const dragY = useSharedValue(0);
  const dragContext = useSharedValue(0);
  const revealDistance = useSharedValue(hiddenOffset);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const requestClose = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(compact && dismissible)
        .activeOffsetY([-8, 8])
        .failOffsetX([-12, 12])
        .onStart(() => {
          // Grabbing a sheet mid-flight must continue from where the eye last saw it.
          cancelAnimation(dragY);
          dragContext.set(dragY.get());
        })
        .onUpdate((event) => {
          dragY.set(Math.max(0, dragContext.get() + event.translationY));
        })
        .onEnd((event) => {
          if (event.translationY > 88 || event.velocityY > 850) {
            dragY.set(
              withSpring(height, { duration: 300, dampingRatio: 1, velocity: event.velocityY, overshootClamping: true, reduceMotion: ReduceMotion.System }, (finished) => {
                if (finished) scheduleOnRN(requestClose);
              }),
            );
            return;
          }
          dragY.set(withSpring(0, { duration: 300, dampingRatio: 0.8, velocity: event.velocityY, reduceMotion: ReduceMotion.System }));
        })
        .onFinalize((_event, success) => {
          if (!success) dragY.set(withSpring(0, { duration: 300, dampingRatio: 0.8, reduceMotion: ReduceMotion.System }));
        }),
    [compact, dismissible, dragContext, dragY, height, requestClose],
  );

  useEffect(() => {
    revealDistance.set(hiddenOffset);
  }, [hiddenOffset, revealDistance]);

  useEffect(() => {
    if (!visible) return;
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSubscription = Keyboard.addListener(showEvent, (event) => setKeyboardHeight(event.endCoordinates.height));
    const hideSubscription = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [visible]);

  useEffect(() => {
    cancelAnimation(progress);
    cancelAnimation(dragY);
    dragY.set(0);
    dragContext.set(0);

    if (!visible) {
      progress.set(0);
      return;
    }

    const frame = requestAnimationFrame(() => {
      progress.set(withTiming(1, { duration: OPEN_DURATION_MS, reduceMotion: ReduceMotion.System }));
    });

    return () => cancelAnimationFrame(frame);
  }, [dragContext, dragY, progress, visible]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.get() * 0.56,
  }));
  const compactPanelStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: (1 - progress.get()) * revealDistance.get() + dragY.get() }],
  }));
  const desktopPanelStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: (1 - progress.get()) * 14 }, { scale: 0.98 + progress.get() * 0.02 }],
  }));
  const availableHeight = Math.max(0, height - keyboardHeight);
  const maxHeight = compact
    ? Math.max(0, availableHeight - insets.top - 12)
    : Math.max(0, Math.min(availableHeight - 48, 760));
  const bottomPadding = Math.max(insets.bottom, theme.spacing.lg);
  // Wrap-content sheets only have maxHeight. A flex:1 scroller then collapses to 0 and hides the body.
  const bodyMaxHeight = Math.max(160, maxHeight - (compact ? 100 : 82) - (footer ? 130 : 20));
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
      <GestureHandlerRootView style={styles.overlay} testID={testID}>
        <Reanimated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable accessible={false} aria-hidden tabIndex={-1} style={styles.fill} onPress={requestClose} />
        </Reanimated.View>
        <KeyboardAvoidingView
          pointerEvents="box-none"
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={[styles.stage, compact ? styles.compactStage : styles.desktopStage]}
        >
          <Reanimated.View
            collapsable={false}
            accessibilityViewIsModal
            role="dialog"
            style={[
              styles.panel,
              compact ? styles.compactPanel : styles.desktopPanel,
              {
                maxHeight,
                height: compact && fullHeight ? maxHeight : undefined,
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
              },
              compact ? compactPanelStyle : desktopPanelStyle,
            ]}
          >
            {compact ? (
              <GestureDetector gesture={pan}>
                <View testID={dismissible && testID ? `${testID}-drag-handle` : undefined} style={styles.dragArea}>
                  {dismissible ? <View style={[styles.dragHandle, { backgroundColor: theme.colors.borderStrong }]} /> : null}
                </View>
              </GestureDetector>
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
                style={fullHeight ? styles.scroller : { maxHeight: bodyMaxHeight }}
                contentContainerStyle={resolvedContentStyle}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {children}
              </ScrollView>
            ) : (
              <View collapsable={false} style={resolvedContentStyle}>{children}</View>
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
          </Reanimated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

export function SheetAction({
  icon,
  title,
  detail,
  onPress,
  disabled = false,
  tone = "default",
}: {
  icon: IconName;
  title: string;
  detail?: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}) {
  const theme = useAppTheme();
  const toneColor = tone === "danger" ? theme.colors.danger : theme.colors.accent;
  const toneBackground = tone === "danger" ? theme.colors.dangerSoft : theme.colors.accentSoft;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
     
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: pressed ? theme.colors.surfacePressed : "transparent",
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <View style={[styles.actionIcon, { backgroundColor: toneBackground }]}>
        <AppIcon name={icon} size={18} color={toneColor} />
      </View>
      <View style={styles.actionText}>
        <Text style={[typography.bodyMedium, { color: tone === "danger" ? toneColor : theme.colors.text }]}>{title}</Text>
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
    height: 30,
    marginBottom: -2,
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
    zIndex: 2,
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
    flex: 1,
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
