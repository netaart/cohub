import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { dismissToast, pushToast, type ToastEntry, type ToastTone } from "@/src/data/toast-queue";
import { useTranslation } from "@/src/i18n";
import { motion } from "@/src/motion";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon } from "@/src/ui";

type ShowToast = (toast: { title: string; message?: string; tone?: ToastTone }) => void;

const ToastContext = createContext<ShowToast | null>(null);

/** Vertical offset per older toast; the stack should read as depth, not as a list. */
const STACK_OFFSET = 10;
const AUTO_DISMISS_MS = 3200;
const DISMISS_DISTANCE = 56;
const DISMISS_VELOCITY = 800;

export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used inside ToastProvider");
  return show;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const counter = useRef(0);

  const show = useCallback<ShowToast>(({ title, message, tone = "neutral" }) => {
    counter.current += 1;
    const entry: ToastEntry = { key: `toast-${counter.current}`, title, message, tone };
    setToasts((current) => pushToast(current, entry));
    AccessibilityInfo.announceForAccessibility(message ? `${title}. ${message}` : title);
  }, []);

  const dismiss = useCallback((key: string) => {
    setToasts((current) => dismissToast(current, key));
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
    <ToastLayer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastLayer({ toasts, onDismiss }: { toasts: ToastEntry[]; onDismiss: (key: string) => void }) {
  const insets = useSafeAreaInsets();
  if (toasts.length === 0) return null;
  // Oldest first so the newest toast is last in the tree and wins hit-testing.
  const ordered = toasts.slice().reverse();
  return (
    <View pointerEvents="box-none" style={[styles.layer, { bottom: insets.bottom + 84 }]}>
      {ordered.map((toast) => <ToastCard key={toast.key} toast={toast} depth={toasts.indexOf(toast)} onDismiss={onDismiss} />)}
    </View>
  );
}

const enterSpring = { duration: 400, dampingRatio: 1, reduceMotion: ReduceMotion.System } as const;

function ToastCard({ toast, depth, onDismiss }: { toast: ToastEntry; depth: number; onDismiss: (key: string) => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const isFront = depth === 0;

  const enter = useSharedValue(0);
  const translateX = useSharedValue(0);
  const stackDepth = useSharedValue(depth);

  useEffect(() => {
    enter.set(withSpring(1, enterSpring));
  }, [enter]);

  useEffect(() => {
    stackDepth.set(withSpring(depth, enterSpring));
  }, [depth, stackDepth]);

  const finishDismiss = useCallback(() => onDismiss(toast.key), [onDismiss, toast.key]);

  useEffect(() => {
    if (!isFront) return;
    const timer = setTimeout(() => {
      // Auto-dismiss fades in place: nothing pushed it, so nothing should throw it.
      enter.set(withTiming(0, { duration: motion.settle.duration, reduceMotion: ReduceMotion.System }, (finished) => {
        if (finished) scheduleOnRN(finishDismiss);
    }));
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [enter, finishDismiss, isFront]);

  const onPanUpdate = (translationX: number) => {
    "worklet";
    translateX.set(translationX);
  };

  const onPanEnd = (translationX: number, velocityX: number) => {
    "worklet";
    const flung = Math.abs(velocityX) > DISMISS_VELOCITY;
    const farEnough = Math.abs(translationX) > DISMISS_DISTANCE;
    if (!flung && !farEnough) {
      translateX.set(withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: velocityX, reduceMotion: ReduceMotion.System }));
      return;
    }
    const direction = translationX < 0 || (translationX === 0 && velocityX < 0) ? -1 : 1;
    const exit = { duration: 300, dampingRatio: 1, velocity: velocityX, overshootClamping: true, reduceMotion: ReduceMotion.System };
    translateX.set(withSpring(direction * width, exit, (finished) => {
      if (finished) scheduleOnRN(finishDismiss);
    }));
  };

  const pan = useMemo(
    () => Gesture.Pan().enabled(isFront).activeOffsetX([-10, 10]).failOffsetY([-12, 12]).onUpdate((event) => onPanUpdate(event.translationX)).onEnd((event) => onPanEnd(event.translationX, event.velocityX)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- worklet callbacks close over stable shared values
    [isFront, finishDismiss, width],
  );

  const animatedStyle = useAnimatedStyle(() => {
    const d = stackDepth.get();
    const e = enter.get();
    return {
  opacity: e * (1 - d * 0.35),
      transform: [{ translateY: (1 - e) * 16 - d * STACK_OFFSET }, { translateX: translateX.get() }, { scale: (0.96 + 0.04 * e) * (1 - d * 0.04) }],
    };
  });

  const danger = toast.tone === "danger";
  const label = toast.message ? `${toast.title}. ${toast.message}` : toast.title;
  const frame = { zIndex: 10 - depth, backgroundColor: theme.colors.surfaceRaised, borderColor: danger ? theme.colors.danger : theme.colors.borderStrong, shadowColor: theme.colors.shadow };

  return (
    <GestureDetector gesture={pan}>
    <Reanimated.View accessible accessibilityRole="alert" accessibilityLabel={label} accessibilityHint={isFront ? t("toast.swipeHint") : undefined} pointerEvents={isFront ? "auto" : "none"} style={[styles.card, frame, animatedStyle]}>
        <AppIcon name={danger ? "alert" : "check"} size={16} color={danger ? theme.colors.danger : theme.colors.success} />
        <View style={styles.text}>
          <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{toast.title}</Text>
          {toast.message ? <Text numberOfLines={2} style={[typography.caption, { color: theme.colors.textSecondary }]}>{toast.message}</Text> : null}
        </View>
      </Reanimated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 12, right: 12, zIndex: 90 },
  card: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 16, borderCurve: "continuous", borderWidth: 1, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 12, elevation: 6 },
  text: { flex: 1, minWidth: 0, gap: 1 },
});
