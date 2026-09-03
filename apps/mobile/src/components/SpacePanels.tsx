/* eslint-disable react-hooks/refs -- PanResponder needs stable mutable gesture state. */
/* eslint-disable react-hooks/immutability -- Reanimated shared values are intentionally mutated by gesture worklets. */
/* eslint-disable react-hooks/set-state-in-effect -- controlled panel state synchronizes the native animation surface. */
import type { CohubClient, SpaceFsEntry, UserSessionListItem } from "@neta-art/cohub";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, BackHandler, FlatList, Modal, PanResponder, Platform, Pressable, Text, View, useWindowDimensions, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { cancelAnimation, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionSearchRow } from "@/src/components/SearchResultRow";
import { SessionRow } from "@/src/components/SessionRow";
import { SpaceFileRow } from "@/src/components/SpaceFileRow";
import { useAppTheme, typography } from "@/src/theme";
import { normalizeSearchQuery, useRemoteSearch, type RemoteSessionSearchHit, type SessionNavigationTarget } from "@/src/data/session-search";
import { getResourcePinState, isResourcePinned, loadResourcePinStates, toggleResourcePin } from "@/src/data/resource-pins";
import { PANEL_CLOSE_THRESHOLD, PANEL_OPEN_THRESHOLD, PANEL_SWIPE_VELOCITY, panelForOpeningDelta, panelForSide, shouldClosePanel, shouldOpenPanel, sideForPanel, type PanelName, type PanelSide } from "@/src/data/space-panel-gesture";
import { AppIcon, IconButton, PrimaryButton, SearchField } from "@/src/ui";
import { normalizeSpacePath, parentSpacePath, sortByRecent, spacePathName } from "@/src/utils";

export type SpacePanel = "chat" | "files";

type SpacePanelsProps = {
  spaceId: string;
  spaceName: string;
  sessions: UserSessionListItem[];
  client: CohubClient | null;
  activePanel: SpacePanel | null;
  onActivePanelChange: (panel: SpacePanel | null) => void;
  onOpenSession: (sessionId: string, target?: SessionNavigationTarget) => void;
  onNewChat: () => void;
  onOpenFile: (path: string) => void;
  onOpenFilesPage: () => void;
  children: ReactNode;
};

const PANEL_WIDTH_RATIO = 0.86;
const MAX_PANEL_WIDTH = 360;
const ANIMATION_DURATION_MS = 220;
const USE_NATIVE_DRIVER = Platform.OS !== "web";
// These CSS properties are supported by React Native Web but are not in the shared RN ViewStyle type.
const WEB_GESTURE_STYLE: ViewStyle | undefined = Platform.OS === "web"
  ? ({ touchAction: "pan-y" } as unknown as ViewStyle)
  : undefined;
const WEB_NO_SELECT_STYLE: ViewStyle | undefined = Platform.OS === "web"
  ? ({ userSelect: "none" } as unknown as ViewStyle)
  : undefined;

type GestureController = {
  activePanel: SpacePanel | null;
  visibleSide: SpacePanel | null;
  gestureSide: SpacePanel | null;
  gestureDistance: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// Native uses one RNGH pan surface so the two panel directions cannot compete.
export function SpacePanels(props: SpacePanelsProps) {
  return Platform.OS === "web" ? <WebSpacePanels {...props} /> : <NativeSpacePanels {...props} />;
}

function NativeSpacePanels({ spaceId, spaceName, sessions, client, activePanel, onActivePanelChange, onOpenSession, onNewChat, onOpenFile, onOpenFilesPage, children }: SpacePanelsProps) {
  const theme = useAppTheme();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(MAX_PANEL_WIDTH, Math.max(280, width * PANEL_WIDTH_RATIO));
  const progress = useSharedValue(activePanel ? 1 : 0);
  const activeSide = useSharedValue<PanelSide | 0>(activePanel ? sideForPanel(activePanel) : 0);
  const gestureSide = useSharedValue<PanelSide | 0>(0);
  const gestureStartSide = useSharedValue<PanelSide | 0>(0);
  const gestureStartProgress = useSharedValue(0);
  const gestureActive = useSharedValue(false);
  const animationId = useSharedValue(0);
  const [visiblePanel, setVisiblePanel] = useState<SpacePanel | null>(activePanel);
  const [interactive, setInteractive] = useState(Boolean(activePanel));
  const visiblePanelRef = useRef<SpacePanel | null>(activePanel);
  const activePanelRef = useRef<SpacePanel | null>(activePanel);

  const clearClosedPanel = useCallback((panel: PanelName) => {
    if (activePanelRef.current !== null || visiblePanelRef.current !== panel) return;
    visiblePanelRef.current = null;
    setVisiblePanel(null);
    setInteractive(false);
    activeSide.value = 0;
    gestureSide.value = 0;
  }, [activeSide, gestureSide]);

  const finishClosedPanel = useCallback((panel: PanelName) => {
    if (activePanelRef.current === panel) {
      activePanelRef.current = null;
      setInteractive(false);
      onActivePanelChange(null);
    }
    clearClosedPanel(panel);
  }, [clearClosedPanel, onActivePanelChange]);

  const animateClosed = useCallback((panel: PanelName) => {
    activeSide.value = sideForPanel(panel);
    gestureSide.value = 0;
    const currentAnimation = animationId.value + 1;
    animationId.value = currentAnimation;
    progress.value = withSpring(0, {
      damping: 28,
      stiffness: 420,
      mass: 0.9,
      overshootClamping: true,
    }, (finished) => {
      if (finished && animationId.value === currentAnimation) runOnJS(finishClosedPanel)(panel);
    });
  }, [activeSide, animationId, finishClosedPanel, gestureSide, progress]);

  const closePanel = useCallback((panel: SpacePanel) => {
    if (visiblePanelRef.current !== panel) return;
    activePanelRef.current = null;
    setInteractive(false);
    onActivePanelChange(null);
    animateClosed(panel);
  }, [animateClosed, onActivePanelChange]);

  const showGesturePanel = useCallback((panel: PanelName) => {
    if (visiblePanelRef.current === panel) return;
    visiblePanelRef.current = panel;
    setVisiblePanel(panel);
  }, []);

  const commitOpen = useCallback((panel: PanelName) => {
    activePanelRef.current = panel;
    visiblePanelRef.current = panel;
    setVisiblePanel(panel);
    setInteractive(true);
    activeSide.value = sideForPanel(panel);
    gestureSide.value = 0;
    onActivePanelChange(panel);
  }, [activeSide, gestureSide, onActivePanelChange]);

  const commitClose = useCallback((panel: PanelName) => {
    if (activePanelRef.current !== panel) return;
    activePanelRef.current = null;
    setInteractive(false);
    onActivePanelChange(null);
  }, [onActivePanelChange]);

  useEffect(() => {
    if (activePanel === activePanelRef.current) return;
    activePanelRef.current = activePanel;
    if (activePanel) {
      visiblePanelRef.current = activePanel;
      setVisiblePanel(activePanel);
      setInteractive(true);
      activeSide.value = sideForPanel(activePanel);
      gestureSide.value = 0;
      animationId.value += 1;
      progress.value = withSpring(1, {
        damping: 28,
        stiffness: 420,
        mass: 0.9,
        overshootClamping: true,
      });
      return;
    }
    const panel = visiblePanelRef.current;
    if (panel) {
      setInteractive(false);
      animateClosed(panel);
    }
  }, [activePanel, activeSide, animateClosed, animationId, gestureSide, progress]);

  useEffect(() => {
    if (!isFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      const panel = activePanelRef.current ?? visiblePanelRef.current;
      if (!panel) return false;
      closePanel(panel);
      return true;
    });
    return () => subscription.remove();
  }, [closePanel, isFocused]);

  const panGesture = useMemo(() => Gesture.Pan()
    .activeOffsetX([-8, 8])
    .failOffsetY([-15, 15])
    .onStart(() => {
      "worklet";
      gestureActive.value = true;
      gestureStartSide.value = activeSide.value;
      gestureStartProgress.value = progress.value;
      gestureSide.value = 0;
      cancelAnimation(progress);
    })
    .onUpdate((event) => {
      "worklet";
      const startSide = gestureStartSide.value;
      if (startSide === 0) {
        let side = gestureSide.value;
        if (side === 0 && Math.abs(event.translationX) >= 8) {
          const panel = panelForOpeningDelta(event.translationX);
          if (panel) {
            side = sideForPanel(panel);
            gestureSide.value = side;
            runOnJS(showGesturePanel)(panel);
          }
        }
        if (side === 0) return;
        const distance = side === -1 ? Math.max(0, event.translationX) : Math.max(0, -event.translationX);
        progress.value = Math.min(1, distance / panelWidth);
        return;
      }
      const distance = startSide === -1 ? Math.max(0, -event.translationX) : Math.max(0, event.translationX);
      progress.value = Math.max(0, gestureStartProgress.value - distance / panelWidth);
    })
    .onEnd((event, success) => {
      "worklet";
      if (!success) return;
      gestureActive.value = false;
      const startSide = gestureStartSide.value;
      if (startSide === 0) {
        const side = gestureSide.value;
        if (side === 0) {
          progress.value = 0;
          return;
        }
        const panel = panelForSide(side);
        const distance = progress.value * panelWidth;
        // RNGH reports points/second; the shared helper uses PanResponder's points/millisecond.
        const velocityTowardOpen = (side === -1 ? event.velocityX : -event.velocityX) / 1000;
        if (shouldOpenPanel(distance, panelWidth, velocityTowardOpen)) {
          activeSide.value = side;
          gestureSide.value = 0;
          const currentAnimation = animationId.value + 1;
          animationId.value = currentAnimation;
          progress.value = withSpring(1, {
            damping: 28,
            stiffness: 420,
            mass: 0.9,
            overshootClamping: true,
          });
          runOnJS(commitOpen)(panel);
        } else {
          const currentAnimation = animationId.value + 1;
          animationId.value = currentAnimation;
          progress.value = withSpring(0, {
            damping: 28,
            stiffness: 420,
            mass: 0.9,
            overshootClamping: true,
          }, (finished) => {
            if (finished && animationId.value === currentAnimation) runOnJS(clearClosedPanel)(panel);
          });
        }
        return;
      }

      const panel = panelForSide(startSide);
      const distance = panel === "chat" ? Math.max(0, -event.translationX) : Math.max(0, event.translationX);
      const velocityTowardClose = (panel === "chat" ? -event.velocityX : event.velocityX) / 1000;
      if (shouldClosePanel(distance, panelWidth, velocityTowardClose)) {
        const currentAnimation = animationId.value + 1;
        animationId.value = currentAnimation;
        progress.value = withSpring(0, {
          damping: 28,
          stiffness: 420,
          mass: 0.9,
          overshootClamping: true,
        }, (finished) => {
          if (finished && animationId.value === currentAnimation) runOnJS(finishClosedPanel)(panel);
        });
        runOnJS(commitClose)(panel);
      } else {
        const currentAnimation = animationId.value + 1;
        animationId.value = currentAnimation;
        progress.value = withSpring(1, {
          damping: 28,
          stiffness: 420,
          mass: 0.9,
          overshootClamping: true,
        });
      }
    })
    .onFinalize((_, success) => {
      "worklet";
      if (!gestureActive.value || success) return;
      gestureActive.value = false;
      const startSide = gestureStartSide.value;
      const canceledSide = gestureSide.value;
      if (canceledSide !== 0) activeSide.value = canceledSide;
      gestureSide.value = 0;
      const target = startSide === 0 ? 0 : 1;
      const currentAnimation = animationId.value + 1;
      animationId.value = currentAnimation;
      progress.value = withSpring(target, {
        damping: 28,
        stiffness: 420,
        mass: 0.9,
        overshootClamping: true,
      }, (finished) => {
        if (finished && target === 0 && animationId.value === currentAnimation) {
          if (canceledSide !== 0) runOnJS(clearClosedPanel)(panelForSide(canceledSide));
        }
      });
    }), [activeSide, animationId, clearClosedPanel, commitClose, commitOpen, finishClosedPanel, gestureActive, gestureSide, gestureStartProgress, gestureStartSide, panelWidth, progress, showGesturePanel]);

  const panelStyle = useAnimatedStyle(() => {
    const side = activeSide.value === 0 ? gestureSide.value : activeSide.value;
    const closedOffset = side < 0 ? -panelWidth : panelWidth;
    return {
      transform: [{ translateX: interpolate(progress.value, [0, 1], [closedOffset, 0], Extrapolation.CLAMP) }],
    };
  }, [panelWidth]);
  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.52 }));

  return <GestureDetector gesture={panGesture} userSelect="none" enableContextMenu={false} touchAction="pan-y">
    <View collapsable={false} style={styles.nativeRoot}>
      {children}
      {visiblePanel ? <Reanimated.View pointerEvents={interactive ? "box-none" : "none"} style={styles.nativeOverlay}>
        <Reanimated.View pointerEvents={interactive ? "auto" : "none"} style={[styles.backdrop, backdropStyle]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close panel" style={styles.fill} onPress={() => closePanel(visiblePanel)} />
        </Reanimated.View>
        <Reanimated.View
          collapsable={false}
          testID={`space-panel-${visiblePanel}`}
          pointerEvents={interactive ? "auto" : "none"}
          accessibilityViewIsModal={interactive}
          accessibilityElementsHidden={!interactive}
          importantForAccessibility={interactive ? "yes" : "no-hide-descendants"}
          role="dialog"
          style={[styles.panel, panelStyle, { width: panelWidth, paddingBottom: insets.bottom, backgroundColor: theme.colors.background, borderColor: theme.colors.border, left: visiblePanel === "chat" ? 0 : undefined, right: visiblePanel === "files" ? 0 : undefined }]}
        >
          {interactive
            ? visiblePanel === "chat"
              ? <ChatPanel spaceId={spaceId} spaceName={spaceName} sessions={sessions} client={client} onClose={() => closePanel("chat")} onNewChat={() => { closePanel("chat"); onNewChat(); }} onOpenSession={(sessionId, target) => { closePanel("chat"); onOpenSession(sessionId, target); }} />
              : <FilesPanel enabled spaceId={spaceId} spaceName={spaceName} client={client} onClose={() => closePanel("files")} onOpenFile={(path) => { closePanel("files"); onOpenFile(path); }} onOpenFilesPage={() => { closePanel("files"); onOpenFilesPage(); }} />
            : <PanelGesturePreview panel={visiblePanel} />}
        </Reanimated.View>
      </Reanimated.View> : null}
    </View>
  </GestureDetector>;
}

function WebSpacePanels({ spaceId, spaceName, sessions, client, activePanel, onActivePanelChange, onOpenSession, onNewChat, onOpenFile, onOpenFilesPage, children }: SpacePanelsProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const panelWidth = Math.min(MAX_PANEL_WIDTH, Math.max(280, width * PANEL_WIDTH_RATIO));
  const [progress] = useState(() => new Animated.Value(0));
  const [closingSide, setClosingSide] = useState<SpacePanel | null>(null);
  const [gestureSide, setGestureSide] = useState<SpacePanel | null>(null);
  const [gestureActive, setGestureActive] = useState(false);
  const gestureOpeningRef = useRef(false);
  const controllerRef = useRef<GestureController>({ activePanel, visibleSide: activePanel, gestureSide: null, gestureDistance: 0 });

  useEffect(() => {
    controllerRef.current.activePanel = activePanel;
  }, [activePanel]);

  const animateTo = useCallback((value: number, onFinished?: () => void) => {
    progress.stopAnimation();
    Animated.timing(progress, { toValue: value, duration: ANIMATION_DURATION_MS, useNativeDriver: USE_NATIVE_DRIVER }).start(({ finished }) => {
      if (finished) onFinished?.();
    });
  }, [progress]);

  useEffect(() => {
    if (!activePanel) return;
    const openedFromGesture = gestureOpeningRef.current;
    gestureOpeningRef.current = false;
    controllerRef.current.activePanel = activePanel;
    controllerRef.current.visibleSide = activePanel;
    if (openedFromGesture) setGestureSide(null);
    else {
      progress.stopAnimation();
      progress.setValue(0);
    }
    const frame = requestAnimationFrame(() => animateTo(1));
    return () => cancelAnimationFrame(frame);
  }, [activePanel, animateTo, progress]);

  const closeDrawer = useCallback(() => {
    const side = activePanel ?? controllerRef.current.visibleSide;
    if (!side) return;
    controllerRef.current.visibleSide = side;
    controllerRef.current.gestureSide = null;
    setClosingSide(side);
    onActivePanelChange(null);
    animateTo(0, () => {
      if (controllerRef.current.activePanel === null) {
        controllerRef.current.visibleSide = null;
        setClosingSide(null);
      }
    });
  }, [activePanel, animateTo, onActivePanelChange]);

  const visibleSide = activePanel ?? closingSide ?? gestureSide;
  const drawerMounted = activePanel !== null || closingSide !== null;

  const screenResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, gesture) => {
      if (controllerRef.current.activePanel || controllerRef.current.visibleSide) return false;
      return Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.15;
    },
    onPanResponderGrant: () => {
      setGestureActive(true);
      controllerRef.current.gestureSide = null;
      controllerRef.current.gestureDistance = 0;
      controllerRef.current.visibleSide = null;
      setClosingSide(null);
      setGestureSide(null);
      progress.stopAnimation();
      progress.setValue(0);
    },
    onPanResponderMove: (_, gesture) => {
      let side = controllerRef.current.gestureSide;
      if (!side) {
        side = gesture.dx >= 0 ? "chat" : "files";
        controllerRef.current.gestureSide = side;
        controllerRef.current.visibleSide = side;
        setGestureSide(side);
      }
      const distance = side === "chat" ? Math.max(0, gesture.dx) : Math.max(0, -gesture.dx);
      controllerRef.current.gestureDistance = distance;
      progress.setValue(clamp(distance / panelWidth, 0, 1));
    },
    onPanResponderRelease: (_, gesture) => {
      setGestureActive(false);
      const side = controllerRef.current.gestureSide;
      if (!side) return;
      const distance = controllerRef.current.gestureDistance;
      const velocity = side === "chat" ? gesture.vx : -gesture.vx;
      controllerRef.current.gestureSide = null;
      if (distance / panelWidth >= PANEL_OPEN_THRESHOLD || velocity >= PANEL_SWIPE_VELOCITY) {
        gestureOpeningRef.current = true;
        onActivePanelChange(side);
      } else {
        animateTo(0, () => {
          setGestureSide(null);
          controllerRef.current.visibleSide = null;
        });
      }
    },
    onPanResponderTerminate: () => {
      setGestureActive(false);
      controllerRef.current.gestureSide = null;
      animateTo(0, () => {
        setGestureSide(null);
        controllerRef.current.visibleSide = null;
      });
    },
    onPanResponderTerminationRequest: () => false,
  }), [animateTo, onActivePanelChange, panelWidth, progress]);

  const panelResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, gesture) => {
      const side = controllerRef.current.visibleSide;
      if (!side || !controllerRef.current.activePanel) return false;
      const closing = side === "chat" ? gesture.dx < -8 : gesture.dx > 8;
      return closing && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.15;
    },
    onPanResponderMove: (_, gesture) => {
      const side = controllerRef.current.visibleSide;
      if (!side) return;
      const distance = side === "chat" ? Math.max(0, -gesture.dx) : Math.max(0, gesture.dx);
      progress.setValue(clamp(1 - distance / panelWidth, 0, 1));
    },
    onPanResponderRelease: (_, gesture) => {
      setGestureActive(false);
      const side = controllerRef.current.visibleSide;
      if (!side) return;
      const distance = side === "chat" ? Math.max(0, -gesture.dx) : Math.max(0, gesture.dx);
      const velocity = side === "chat" ? -gesture.vx : gesture.vx;
      if (distance / panelWidth >= PANEL_CLOSE_THRESHOLD || velocity >= PANEL_SWIPE_VELOCITY) closeDrawer();
      else animateTo(1);
    },
    onPanResponderTerminate: () => {
      setGestureActive(false);
      animateTo(1);
    },
    onPanResponderTerminationRequest: () => false,
  }), [animateTo, closeDrawer, panelWidth, progress]);

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: visibleSide === "files" ? [panelWidth, 0] : [-panelWidth, 0] });
  const backdropOpacity = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 0.52] });
  const panelPosition = { left: visibleSide === "chat" ? 0 : undefined, right: visibleSide === "files" ? 0 : undefined };

  return <View collapsable={false} style={[{ flex: 1 }, WEB_GESTURE_STYLE, gestureActive ? WEB_NO_SELECT_STYLE : null]} {...screenResponder.panHandlers}>
    {children}
    {!drawerMounted && gestureSide ? <View pointerEvents="none" accessibilityElementsHidden style={[styles.gesturePreviewRoot, { top: -insets.top, bottom: -insets.bottom }]}>
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} />
      <Animated.View style={[styles.panel, { width: panelWidth, paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: theme.colors.background, borderColor: theme.colors.border, ...panelPosition, transform: [{ translateX }] }]}>
        <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
          <AppIcon name={gestureSide === "chat" ? "messages" : "folder-open"} size={19} color={theme.colors.accent} />
          <Text style={[typography.heading, { color: theme.colors.text }]}>{gestureSide === "chat" ? "Chats" : "Files"}</Text>
        </View>
      </Animated.View>
    </View> : null}
    <Modal visible={drawerMounted} transparent animationType="none" statusBarTranslucent navigationBarTranslucent hardwareAccelerated onRequestClose={closeDrawer}>
      <View style={styles.modalRoot}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}><Pressable accessibilityRole="button" accessibilityLabel="Close panel" style={styles.fill} onPress={closeDrawer} /></Animated.View>
        <Animated.View collapsable={false} testID={visibleSide ? `space-panel-${visibleSide}` : undefined} {...panelResponder.panHandlers} accessibilityViewIsModal role="dialog" style={[styles.panel, WEB_GESTURE_STYLE, gestureActive ? WEB_NO_SELECT_STYLE : null, { width: panelWidth, height: Math.max(0, height), paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: theme.colors.background, borderColor: theme.colors.border, ...panelPosition, transform: [{ translateX }] }]}>
            {visibleSide === "chat" ? <ChatPanel spaceId={spaceId} spaceName={spaceName} sessions={sessions} client={client} onClose={closeDrawer} onNewChat={() => { closeDrawer(); onNewChat(); }} onOpenSession={(sessionId, target) => { closeDrawer(); onOpenSession(sessionId, target); }} /> : <FilesPanel spaceId={spaceId} spaceName={spaceName} client={client} onClose={closeDrawer} onOpenFile={(path) => { closeDrawer(); onOpenFile(path); }} onOpenFilesPage={() => { closeDrawer(); onOpenFilesPage(); }} />}
        </Animated.View>
      </View>
    </Modal>
  </View>;
}

function PanelGesturePreview({ panel }: { panel: SpacePanel }) {
  const theme = useAppTheme();
  return <View style={styles.panelContent} accessibilityElementsHidden><View style={[styles.header, { borderBottomColor: theme.colors.border }]}><AppIcon name={panel === "chat" ? "messages" : "folder-open"} size={19} color={theme.colors.accent} /><Text style={[typography.heading, { color: theme.colors.text }]}>{panel === "chat" ? "Chats" : "Files"}</Text></View></View>;
}

function PanelHeader({ title, subtitle, onClose, action }: { title: string; subtitle?: string; onClose: () => void; action?: ReactNode }) {
  const theme = useAppTheme();
  return (
    <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
      <View style={styles.headerText}>
        <Text numberOfLines={1} style={[typography.heading, { color: theme.colors.text }]}>{title}</Text>
        {subtitle ? <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{subtitle}</Text> : null}
      </View>
      {action}
      <IconButton name="x" label={`Close ${title}`} size={36} onPress={onClose} />
    </View>
  );
}

function mergePanelSessions(current: UserSessionListItem[], incoming: UserSessionListItem[], spaceId: string, spaceName: string) {
  const knownSpace = current.find((session) => session.space)?.space ?? { id: spaceId, name: spaceName, slug: null, publicProfile: null };
  const byId = new Map(current.map((session) => [session.id, session]));
  for (const session of incoming) {
    const previous = byId.get(session.id);
    byId.set(session.id, { ...previous, ...session, space: session.space ?? previous?.space ?? knownSpace });
  }
  return sortByRecent([...byId.values()]);
}

function isOlderSession(left: UserSessionListItem, right: UserSessionListItem) {
  const leftTime = left.lastMessageAt ? Date.parse(left.lastMessageAt) : null;
  const rightTime = right.lastMessageAt ? Date.parse(right.lastMessageAt) : null;
  if (leftTime === null && rightTime !== null) return true;
  if (leftTime !== null && rightTime === null) return false;
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime < rightTime;
  return left.id < right.id;
}

function cursorAfterOldestSession(sessions: UserSessionListItem[]) {
  const oldest = sessions.reduce<UserSessionListItem | null>((current, session) => {
    if (!current || isOlderSession(session, current)) return session;
    return current;
  }, null);
  if (!oldest) return null;
  const date = oldest.lastMessageAt ? new Date(oldest.lastMessageAt) : null;
  if (date && !Number.isFinite(date.getTime())) return null;
  return `${date ? date.toISOString() : "null"}|${oldest.id}`;
}

type ChatPanelItem =
  | { kind: "local"; session: UserSessionListItem }
  | { kind: "remote"; hit: RemoteSessionSearchHit };

type ChatPinFilter = "all" | "pinned";

function ChatPanel({ spaceId, spaceName, sessions, client, onClose, onNewChat, onOpenSession }: { spaceId: string; spaceName: string; sessions: UserSessionListItem[]; client: CohubClient | null; onClose: () => void; onNewChat: () => void; onOpenSession: (sessionId: string, target?: SessionNavigationTarget) => void }) {
  const theme = useAppTheme();
  const [query, setQuery] = useState("");
  const [extraSessions, setExtraSessions] = useState<UserSessionListItem[]>([]);
  const [scopeCursor, setScopeCursor] = useState<string | null>(null);
  const [scopeHasMore, setScopeHasMore] = useState(false);
  const [scopeInitialized, setScopeInitialized] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [pinFilter, setPinFilter] = useState<ChatPinFilter>("all");
  const [pinStates, setPinStates] = useState<Record<string, boolean>>({});
  const [pinLoading, setPinLoading] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinRetryToken, setPinRetryToken] = useState(0);
  const pinStatesRef = useRef<Record<string, boolean>>({});
  const pinningIdsRef = useRef(new Set<string>());
  const pinMutationVersionsRef = useRef(new Map<string, number>());
  const [pinningIds, setPinningIds] = useState<Set<string>>(new Set());
  const remoteSearch = useRemoteSearch(client, query, { enabled: Boolean(spaceId), spaceId, types: ["session", "turn"] });
  const displaySessions = useMemo(() => mergePanelSessions(extraSessions, sessions, spaceId, spaceName), [extraSessions, sessions, spaceId, spaceName]);
  const remoteQueryMatches = remoteSearch.query === normalizeSearchQuery(query);
  const pinCandidateIds = useMemo(() => [...new Set([
    ...displaySessions.map((session) => session.id),
    ...(remoteQueryMatches ? remoteSearch.sessions.map((hit) => hit.sessionId) : []),
  ])], [displaySessions, remoteQueryMatches, remoteSearch.sessions]);
  const pinCandidateKey = pinCandidateIds.join("|");
  const updatePinStates = useCallback((next: Record<string, boolean>) => {
    pinStatesRef.current = { ...pinStatesRef.current, ...next };
    setPinStates((current) => ({ ...current, ...next }));
  }, []);

  useEffect(() => {
    pinStatesRef.current = {};
    pinningIdsRef.current.clear();
    pinMutationVersionsRef.current.clear();
    setPinStates({});
    setPinningIds(new Set());
    setPinError(null);
  }, [client, spaceId]);

  useEffect(() => {
    if (!client || pinCandidateIds.length === 0) return;
    const missing = pinCandidateIds.filter((id) => pinStatesRef.current[id] === undefined);
    if (missing.length === 0) {
      setPinLoading(false);
      return;
    }
    let active = true;
    const requestVersions = new Map(missing.map((id) => [id, pinMutationVersionsRef.current.get(id) ?? 0]));
    setPinLoading(true);
    setPinError(null);
    void loadResourcePinStates(client, "session", missing, { force: true }).then((next) => {
      if (!active) return;
      const withoutMutations = Object.fromEntries(Object.entries(next).filter(([id]) =>
        !pinningIdsRef.current.has(id) && (pinMutationVersionsRef.current.get(id) ?? 0) === requestVersions.get(id),
      ));
      updatePinStates(withoutMutations);
    }).catch((error) => {
      if (active) setPinError(error instanceof Error ? error.message : "Unable to load Chat pins");
    }).finally(() => {
      if (active) setPinLoading(false);
    });
    return () => {
      active = false;
    };
  }, [client, pinCandidateKey, pinCandidateIds, pinRetryToken, updatePinStates]);

  useEffect(() => {
    if (!client) return;
    return client.onUserEvent((event) => {
      if (event.type !== "label.assignments.updated") return;
      const payload = event.payload as { resourceType?: unknown; resourceRef?: unknown; assignments?: unknown };
      if (payload.resourceType !== "session" || typeof payload.resourceRef !== "string" || !Array.isArray(payload.assignments)) return;
      if (!pinCandidateIds.includes(payload.resourceRef)) return;
      updatePinStates({ [payload.resourceRef]: isResourcePinned(payload.assignments as { labelSystemKey?: string | null }[]) });
    });
  }, [client, pinCandidateIds, updatePinStates]);

  const togglePin = useCallback(async (sessionId: string) => {
    if (!client || pinningIdsRef.current.has(sessionId)) return;
    pinningIdsRef.current.add(sessionId);
    const mutationVersion = (pinMutationVersionsRef.current.get(sessionId) ?? 0) + 1;
    pinMutationVersionsRef.current.set(sessionId, mutationVersion);
    setPinningIds((current) => new Set([...current, sessionId]));
    setPinError(null);
    let previous = pinStatesRef.current[sessionId];
    try {
      if (previous === undefined) {
        previous = await getResourcePinState(client, "session", sessionId, { force: true });
        if ((pinMutationVersionsRef.current.get(sessionId) ?? 0) !== mutationVersion) return;
        updatePinStates({ [sessionId]: previous });
      }
      const optimistic = !previous;
      updatePinStates({ [sessionId]: optimistic });
      const resolved = await toggleResourcePin(client, "session", sessionId, previous);
      if ((pinMutationVersionsRef.current.get(sessionId) ?? 0) === mutationVersion) updatePinStates({ [sessionId]: resolved });
    } catch (error) {
      if ((pinMutationVersionsRef.current.get(sessionId) ?? 0) !== mutationVersion) return;
      if (previous !== undefined) updatePinStates({ [sessionId]: previous });
      setPinError(error instanceof Error ? error.message : "Unable to update Chat pin");
    } finally {
      pinningIdsRef.current.delete(sessionId);
      setPinningIds((current) => new Set([...current].filter((id) => id !== sessionId)));
    }
  }, [client, updatePinStates]);

  const trimmedQuery = normalizeSearchQuery(query);
  const needle = trimmedQuery.toLowerCase();
  const filteredSessions = displaySessions.filter((session) =>
    (!needle || [session.title, session.latestMessageText, session.space?.name].some((value) => value ? normalizeSearchQuery(value).toLowerCase().includes(needle) : false)) &&
    (pinFilter === "all" || pinStates[session.id] === true),
  );
  const listItems = useMemo<ChatPanelItem[]>(() => {
    if (!trimmedQuery) return filteredSessions.map((session) => ({ kind: "local", session }));
    const remoteSessions = remoteQueryMatches
      ? remoteSearch.sessions.filter((hit) => pinFilter === "all" || pinStates[hit.sessionId] === true)
      : [];
    const remoteIds = new Set(remoteSessions.map((hit) => hit.sessionId));
    return [
      ...remoteSessions.map((hit) => ({ kind: "remote" as const, hit })),
      ...filteredSessions.filter((session) => !remoteIds.has(session.id)).map((session) => ({ kind: "local" as const, session })),
    ];
  }, [filteredSessions, pinFilter, pinStates, remoteQueryMatches, remoteSearch.sessions, trimmedQuery]);
  const loadMore = async () => {
    if (!client || loadingMore || (scopeInitialized && !scopeHasMore)) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const cursor = scopeCursor ?? cursorAfterOldestSession(sessions);
      const response = await client.space(spaceId).sessions.list({ limit: 60, ...(cursor ? { cursor } : {}) });
      setExtraSessions((current) => mergePanelSessions(current, response.sessions, spaceId, spaceName));
      setScopeCursor(response.pageInfo?.nextCursor ?? null);
      setScopeHasMore(Boolean(response.pageInfo?.hasMore));
      setScopeInitialized(true);
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : "Unable to load more Chats");
    } finally {
      setLoadingMore(false);
    }
  };
  const showLoadMore = Boolean(client && !trimmedQuery && (!scopeInitialized || scopeHasMore));
  const emptyLoading = (remoteQueryMatches && remoteSearch.loading) || (pinFilter === "pinned" && pinLoading);
  const emptyLabel = pinFilter === "pinned"
    ? "No pinned Chats"
    : trimmedQuery
      ? "No matching Chats"
      : "No Chats in this Space yet.";
  return (
    <View style={styles.panelContent}>
      <PanelHeader title="Chats" subtitle={spaceName} onClose={onClose} />
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, gap: 9 }}>
        <PrimaryButton label="New Chat" icon="plus" onPress={onNewChat} style={{ minHeight: 44 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}><SearchField value={query} onChangeText={setQuery} placeholder="Search Chats" /></View>
          {remoteQueryMatches && remoteSearch.loading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <PanelFilterChip label="All" selected={pinFilter === "all"} onPress={() => setPinFilter("all")} />
          <PanelFilterChip label="Pinned" icon="pin" selected={pinFilter === "pinned"} onPress={() => setPinFilter("pinned")} />
        </View>
        {remoteQueryMatches && remoteSearch.error && trimmedQuery.length >= 2 ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{remoteSearch.error}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry Chat search" onPress={remoteSearch.retry}><Text style={[typography.micro, { color: theme.colors.accent }]}>Retry</Text></Pressable></View> : null}
        {pinError ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{pinError}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry Chat pins" onPress={() => setPinRetryToken((value) => value + 1)}><Text style={[typography.micro, { color: theme.colors.accent }]}>Retry</Text></Pressable></View> : null}
      </View>
      <FlatList
        data={listItems}
        keyExtractor={(item) => item.kind === "remote" ? `remote:${item.hit.sessionId}` : `local:${item.session.id}`}
        renderItem={({ item }) => item.kind === "remote"
          ? <SessionSearchRow hit={item.hit} pinned={pinStates[item.hit.sessionId] === true} pinning={pinningIds.has(item.hit.sessionId)} onTogglePin={client ? () => void togglePin(item.hit.sessionId) : undefined} onPress={(target) => onOpenSession(item.hit.sessionId, target)} />
          : <SessionRow session={item.session} pinned={pinStates[item.session.id] === true} pinning={pinningIds.has(item.session.id)} onTogglePin={client ? () => void togglePin(item.session.id) : undefined} onPress={() => onOpenSession(item.session.id)} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24, flexGrow: listItems.length === 0 ? 1 : undefined }}
        ListFooterComponent={showLoadMore ? <View>{loadMoreError ? <Text selectable style={[typography.micro, { color: theme.colors.danger, marginHorizontal: 14, marginTop: 8 }]}>{loadMoreError}</Text> : null}<Pressable accessibilityRole="button" accessibilityLabel={loadMoreError ? "Retry loading Chats" : "Load more Chats"} disabled={loadingMore} onPress={() => void loadMore()} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ minHeight: 40, marginHorizontal: 14, marginTop: 8, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}>{loadingMore ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>{loadMoreError ? "Retry loading Chats" : "Load more Chats"}</Text>}</Pressable></View> : null}
        ListEmptyComponent={<View style={styles.emptyPanel}>{emptyLoading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <AppIcon name={pinFilter === "pinned" ? "pin" : trimmedQuery ? "search" : "messages"} size={26} color={theme.colors.textMuted} />}<Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 10, textAlign: "center" }]}>{emptyLabel}</Text></View>}
      />
    </View>
  );
}

function PanelFilterChip({ label, icon, selected, onPress }: { label: string; icon?: React.ComponentProps<typeof AppIcon>["name"]; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ minHeight: 32, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border, backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, flexDirection: "row", alignItems: "center", gap: 5 })}>{icon ? <AppIcon name={icon} size={13} color={selected ? theme.colors.accent : theme.colors.textMuted} /> : null}<Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
}

function FilesPanel({ enabled = true, spaceId, spaceName, client, onClose, onOpenFile, onOpenFilesPage }: { enabled?: boolean; spaceId: string; spaceName: string; client: CohubClient | null; onClose: () => void; onOpenFile: (path: string) => void; onOpenFilesPage: () => void }) {
  const theme = useAppTheme();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<SpaceFsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const currentRequest = ++requestIdRef.current;
    if (!client) {
      setEntries([]);
      setError("Connect to Cohub to browse Files.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await client.space(spaceId).files.list(path || undefined);
      if (currentRequest === requestIdRef.current) setEntries(result.entries);
    } catch (caught) {
      if (currentRequest === requestIdRef.current) setError(caught instanceof Error ? caught.message : "Unable to load Files");
    } finally {
      if (currentRequest === requestIdRef.current) setLoading(false);
    }
  }, [client, enabled, path, spaceId]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      requestIdRef.current += 1;
    };
  }, [enabled, load]);

  const openEntry = (entry: SpaceFsEntry) => {
    if (entry.type === "dir") {
      setPath(normalizeSpacePath(entry.path));
      return;
    }
    onOpenFile(entry.path);
  };

  return (
    <View style={styles.panelContent}>
      <PanelHeader title={path ? spacePathName(path) : "Files"} subtitle={path ? `${spaceName} / ${path}` : spaceName} onClose={onClose} action={<IconButton name="external-link" label="Open full Files" size={36} onPress={onOpenFilesPage} />} />
      {path ? <Pressable accessibilityRole="button" accessibilityLabel="Back to parent folder" onPress={() => setPath(parentSpacePath(path))} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => [styles.parentBar, { borderBottomColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}><AppIcon name="arrow-left" size={16} color={theme.colors.textMuted} /><Text style={[typography.caption, { color: theme.colors.textSecondary }]}>{parentSpacePath(path) ? `Back to ${spacePathName(parentSpacePath(path))}` : "Back to Files"}</Text></Pressable> : null}
      {loading ? (
        <View style={styles.emptyPanel}><ActivityIndicator size="small" color={theme.colors.accent} /><Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 10 }]}>Loading Files…</Text></View>
      ) : error ? (
        <View style={styles.emptyPanel}><AppIcon name="cloud-off" size={25} color={theme.colors.danger} /><Text style={[typography.body, { color: theme.colors.danger, textAlign: "center", marginTop: 10 }]}>{error}</Text><PrimaryButton label="Retry" icon="refresh" onPress={() => void load()} style={{ marginTop: 15, minHeight: 42 }} /></View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.path}
          contentContainerStyle={{ paddingVertical: 8, paddingBottom: 24, flexGrow: entries.length === 0 ? 1 : undefined }}
          renderItem={({ item }) => <SpaceFileRow entry={item} compact onPress={() => openEntry(item)} />}
          ListEmptyComponent={<View style={styles.emptyPanel}><AppIcon name="folder-open" size={26} color={theme.colors.textMuted} /><Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 10, textAlign: "center" }]}>{path ? "This folder is empty." : "This workspace is empty."}</Text></View>}
        />
      )}
    </View>
  );
}

const styles = {
  nativeRoot: { flex: 1, minHeight: 0, overflow: "hidden" as const },
  nativeOverlay: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, zIndex: 20, elevation: 20 },
  modalRoot: { flex: 1 } as const,
  gesturePreviewRoot: { position: "absolute" as const, left: 0, right: 0, zIndex: 20, elevation: 20 },
  fill: { flex: 1 } as const,
  backdrop: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "#000000" },
  panel: { position: "absolute" as const, top: 0, bottom: 0, borderLeftWidth: 1, borderRightWidth: 1, shadowColor: "#000000", shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.25, shadowRadius: 18, elevation: 12 },
  panelContent: { flex: 1, minHeight: 0 },
  header: { minHeight: 62, paddingHorizontal: 10, paddingVertical: 7, flexDirection: "row" as const, alignItems: "center" as const, gap: 5, borderBottomWidth: 1 },
  headerText: { flex: 1, minWidth: 0, paddingHorizontal: 3 },
  emptyPanel: { flex: 1, minHeight: 180, alignItems: "center" as const, justifyContent: "center" as const, padding: 24 },
  parentBar: { minHeight: 40, paddingHorizontal: 14, flexDirection: "row" as const, alignItems: "center" as const, gap: 8, borderBottomWidth: 1 },
} satisfies Record<string, object>;
