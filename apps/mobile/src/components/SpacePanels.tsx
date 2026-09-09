/* eslint-disable react-hooks/refs -- gesture callbacks read panel refs that are written outside render. */
/* eslint-disable react-hooks/immutability -- Reanimated shared values are intentionally mutated by gesture worklets. */
/* eslint-disable react-hooks/set-state-in-effect -- controlled panel state synchronizes the native animation surface. */
import type { CohubClient, SpaceFsEntry, UserSessionListItem } from "@neta-art/cohub";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, BackHandler, FlatList, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { cancelAnimation, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionSearchRow } from "@/src/components/SearchResultRow";
import { SessionRow } from "@/src/components/SessionRow";
import { SessionLabelSheet } from "@/src/components/SessionLabelSheet";
import { SpaceFileRow } from "@/src/components/SpaceFileRow";
import { useAppTheme, typography } from "@/src/theme";
import { normalizeSearchQuery, useRemoteSearch, type RemoteSessionSearchHit, type SessionNavigationTarget } from "@/src/data/session-search";
import { useApp } from "@/src/data/context";
import {
  fetchLabelSessionIds,
  fetchSessionLabels,
  formatLabelRef,
  sessionSourceGroup,
  toUserSessionLabels,
  type SessionLabel,
  type SessionSourceGroup,
} from "@/src/data/session-labels";
import { panelForOpeningDelta, panelForSide, shouldClosePanel, shouldOpenPanel, sideForPanel, type PanelName, type PanelSide } from "@/src/data/space-panel-gesture";
import { AppIcon, Avatar, IconButton, PrimaryButton, SearchField } from "@/src/ui";
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
  /** False while the timeline owns the gesture, e.g. selecting message text. */
  swipeEnabled?: boolean;
  children: ReactNode;
};

const PANEL_WIDTH_RATIO = 0.86;
const MAX_PANEL_WIDTH = 360;

// One RNGH pan surface so the two panel directions cannot compete.
export function SpacePanels({ spaceId, spaceName, sessions, client, activePanel, onActivePanelChange, onOpenSession, onNewChat, onOpenFile, onOpenFilesPage, swipeEnabled = true, children }: SpacePanelsProps) {
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

  // The chip row is a native horizontal ScrollView. Touch-start inside it must scroll the row instead of swiping the panel.
  const chipsRect = useSharedValue<ChipsRect>({ x: -1, y: -1, width: 0, height: 0 });
  const panGesture = useMemo(() => Gesture.Pan()
    .enabled(swipeEnabled)
    .activeOffsetX([-4, 4])
    .failOffsetY([-15, 15])
    .onTouchesDown((event, manager) => {
      "worklet";
      const touch = event.allTouches[0];
      if (!touch) return;
      const rect = chipsRect.value;
      if (rect.width > 0 && touch.absoluteX >= rect.x && touch.absoluteX <= rect.x + rect.width && touch.absoluteY >= rect.y && touch.absoluteY <= rect.y + rect.height) manager.fail();
    })
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
    }), [activeSide, animationId, chipsRect, clearClosedPanel, commitClose, commitOpen, finishClosedPanel, gestureActive, gestureSide, gestureStartProgress, gestureStartSide, panelWidth, progress, showGesturePanel, swipeEnabled]);

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
              ? <ChatPanel spaceId={spaceId} spaceName={spaceName} sessions={sessions} client={client} chipsRect={chipsRect} onClose={() => closePanel("chat")} onNewChat={() => { closePanel("chat"); onNewChat(); }} onOpenSession={(sessionId, target) => { closePanel("chat"); onOpenSession(sessionId, target); }} />
              : <FilesPanel enabled spaceId={spaceId} spaceName={spaceName} client={client} onClose={() => closePanel("files")} onOpenFile={(path) => { closePanel("files"); onOpenFile(path); }} onOpenFilesPage={() => { closePanel("files"); onOpenFilesPage(); }} />
            : <PanelGesturePreview panel={visiblePanel} />}
        </Reanimated.View>
      </Reanimated.View> : null}
    </View>
  </GestureDetector>;
}

function PanelGesturePreview({ panel }: { panel: SpacePanel }) {
  const theme = useAppTheme();
  return <View style={styles.panelContent} accessibilityElementsHidden><View style={[styles.header, { borderBottomColor: theme.colors.border }]}><AppIcon name={panel === "chat" ? "messages" : "folder-open"} size={19} color={theme.colors.accent} /><Text style={[typography.heading, { color: theme.colors.text }]}>{panel === "chat" ? "Chats" : "Files"}</Text></View></View>;
}

function PanelHeader({ title, subtitle, onClose, action, avatar }: { title: string; subtitle?: string; onClose: () => void; action?: ReactNode; avatar?: ReactNode }) {
  const theme = useAppTheme();
  return (
    <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
      {avatar}
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

type ChatListFilter =
  | { kind: "all" }
  | { kind: "source"; source: SessionSourceGroup }
  | { kind: "label"; label: SessionLabel; ref: string };

type ChipsRect = { x: number; y: number; width: number; height: number };

function ChatPanel({ spaceId, spaceName, sessions, client, chipsRect, onClose, onNewChat, onOpenSession }: { spaceId: string; spaceName: string; sessions: UserSessionListItem[]; client: CohubClient | null; chipsRect?: SharedValue<ChipsRect>; onClose: () => void; onNewChat: () => void; onOpenSession: (sessionId: string, target?: SessionNavigationTarget) => void }) {
  const theme = useAppTheme();
  const { state, refreshSessionStatuses } = useApp();
  const [query, setQuery] = useState("");
  const [extraSessions, setExtraSessions] = useState<UserSessionListItem[]>([]);
  const [scopeCursor, setScopeCursor] = useState<string | null>(null);
  const [scopeHasMore, setScopeHasMore] = useState(false);
  const [scopeInitialized, setScopeInitialized] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<ChatListFilter>({ kind: "all" });
  const [labels, setLabels] = useState<SessionLabel[]>([]);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [labelsReloadToken, setLabelsReloadToken] = useState(0);
  const [labelSessionIds, setLabelSessionIds] = useState<Set<string>>(new Set());
  const [labelSessionsLoading, setLabelSessionsLoading] = useState(false);
  const [labelSessionsError, setLabelSessionsError] = useState<string | null>(null);
  const [labelSheetSession, setLabelSheetSession] = useState<UserSessionListItem | null>(null);
  const remoteSearch = useRemoteSearch(client, query, { enabled: Boolean(spaceId), spaceId, types: ["session", "turn"] });
  const displaySessions = useMemo(() => mergePanelSessions(extraSessions, sessions, spaceId, spaceName), [extraSessions, sessions, spaceId, spaceName]);
  const remoteQueryMatches = remoteSearch.query === normalizeSearchQuery(query);

  useEffect(() => {
    setLabels([]);
    setLabelsError(null);
    setListFilter({ kind: "all" });
    setLabelSheetSession(null);
  }, [client, spaceId]);

  useEffect(() => {
    if (!client || !spaceId) return;
    let active = true;
    setLabelsError(null);
    void fetchSessionLabels(client, spaceId)
      .then((tree) => {
        if (!active) return;
        setLabels(toUserSessionLabels(tree));
      })
      .catch((error) => {
        if (active) setLabelsError(error instanceof Error ? error.message : "Unable to load labels");
      });
    return () => {
      active = false;
    };
  }, [client, spaceId, labelsReloadToken]);

  useEffect(() => {
    if (!client || !spaceId || listFilter.kind !== "label") {
      setLabelSessionIds(new Set());
      setLabelSessionsError(null);
      return;
    }
    let active = true;
    setLabelSessionsLoading(true);
    setLabelSessionsError(null);
    void fetchLabelSessionIds(client, spaceId, listFilter.ref)
      .then((ids) => {
        if (active) setLabelSessionIds(new Set(ids));
      })
      .catch((error) => {
        if (active) setLabelSessionsError(error instanceof Error ? error.message : "Unable to load labeled Chats");
      })
      .finally(() => {
        if (active) setLabelSessionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, listFilter, spaceId]);

  const openLabelSheet = useCallback((session: UserSessionListItem) => {
    setLabelSheetSession(session);
  }, []);
  const closeLabelSheet = useCallback(() => setLabelSheetSession(null), []);

  const trimmedQuery = normalizeSearchQuery(query);
  const needle = trimmedQuery.toLowerCase();
  const matchesListFilter = (session: UserSessionListItem) => {
    if (listFilter.kind === "all") return true;
    if (listFilter.kind === "source") return sessionSourceGroup(session) === listFilter.source;
    return labelSessionIds.has(session.id);
  };
  const filteredSessions = displaySessions.filter((session) =>
    (!needle || [session.title, session.latestMessageText, session.space?.name].some((value) => value ? normalizeSearchQuery(value).toLowerCase().includes(needle) : false)) &&
    matchesListFilter(session),
  );
  const sessionsById = useMemo(() => new Map(displaySessions.map((session) => [session.id, session])), [displaySessions]);
  const listItems = useMemo<ChatPanelItem[]>(() => {
    if (!trimmedQuery) return filteredSessions.map((session) => ({ kind: "local", session }));
    const remoteSessions = remoteQueryMatches
      ? remoteSearch.sessions.filter((hit) => {
        const session = sessionsById.get(hit.sessionId);
        if (listFilter.kind === "all") return true;
        if (listFilter.kind === "source") return session ? sessionSourceGroup(session) === listFilter.source : false;
        return labelSessionIds.has(hit.sessionId);
      })
      : [];
    const remoteIds = new Set(remoteSessions.map((hit) => hit.sessionId));
    return [
      ...remoteSessions.map((hit) => ({ kind: "remote" as const, hit })),
      ...filteredSessions.filter((session) => !remoteIds.has(session.id)).map((session) => ({ kind: "local" as const, session })),
    ];
  }, [filteredSessions, labelSessionIds, listFilter, remoteQueryMatches, remoteSearch.sessions, sessionsById, trimmedQuery]);
  const loadMore = async () => {
    if (!client || loadingMore || (scopeInitialized && !scopeHasMore)) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const cursor = scopeCursor ?? cursorAfterOldestSession(sessions);
      const response = await client.space(spaceId).sessions.list({ limit: 60, ...(cursor ? { cursor } : {}) });
      setExtraSessions((current) => mergePanelSessions(current, response.sessions, spaceId, spaceName));
      void refreshSessionStatuses(response.sessions);
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
  const emptyLoading = (remoteQueryMatches && remoteSearch.loading) || labelSessionsLoading;
  const emptyLabel = listFilter.kind === "label"
    ? `No Chats labeled “${listFilter.label.name}”`
    : listFilter.kind === "source"
      ? listFilter.source === "web" ? "No Web App Chats" : "No other Chats"
    : trimmedQuery
      ? "No matching Chats"
      : "No Chats in this Space yet.";
  const filterChips: { key: string; label: string; icon?: React.ComponentProps<typeof AppIcon>["name"]; filter: ChatListFilter }[] = [
    { key: "all", label: "All", filter: { kind: "all" } },
    { key: "web", label: "Web App", icon: "globe", filter: { kind: "source", source: "web" } },
    { key: "other", label: "Other", icon: "globe", filter: { kind: "source", source: "other" } },
    ...labels.map((label) => ({ key: `label:${label.id}`, label: label.name, filter: { kind: "label" as const, label, ref: formatLabelRef(label) } })),
  ];
  const chipsRowRef = useRef<View>(null);
  const measureChipsRow = useCallback(() => {
    if (!chipsRect) return;
    chipsRowRef.current?.measureInWindow((x, y, width, height) => {
      chipsRect.value = { x, y, width, height };
    });
  }, [chipsRect]);
  // The panel slides in, so the first layout measurement is off-screen. Re-measure once it settles.
  useEffect(() => {
    const timeout = setTimeout(measureChipsRow, 450);
    return () => clearTimeout(timeout);
  }, [measureChipsRow]);
  const chipRow = <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
    {filterChips.map((chip) => (
      <PanelFilterChip
        key={chip.key}
        label={chip.label}
        icon={chip.icon}
        selected={chip.filter.kind === "all" ? listFilter.kind === "all" : chip.filter.kind === "source" ? listFilter.kind === "source" && listFilter.source === chip.filter.source : listFilter.kind === "label" && listFilter.label.id === chip.filter.label.id}
        onPress={() => setListFilter(chip.filter)}
      />
    ))}
    {labelsError ? <Pressable accessibilityRole="button" accessibilityLabel="Retry loading labels" onPress={() => setLabelsReloadToken((value) => value + 1)}><Text style={[typography.caption, { color: theme.colors.accent }]}>Retry labels</Text></Pressable> : null}
  </ScrollView>;
  return (
    <View style={styles.panelContent}>
      <PanelHeader title={spaceName} subtitle="Chats" onClose={onClose} avatar={<Avatar name={spaceName} uri={displaySessions.find((session) => session.space?.publicProfile?.avatarUrl)?.space?.publicProfile?.avatarUrl} size={38} />} />
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, gap: 9 }}>
        <PrimaryButton label="New Chat" icon="plus" onPress={onNewChat} style={{ minHeight: 44 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}><SearchField value={query} onChangeText={setQuery} placeholder="Search Chats" /></View>
          {remoteQueryMatches && remoteSearch.loading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
        </View>
        <View ref={chipsRowRef} collapsable={false} onLayout={measureChipsRow}>{chipRow}</View>
        {remoteQueryMatches && remoteSearch.error && trimmedQuery.length >= 2 ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{remoteSearch.error}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry Chat search" onPress={remoteSearch.retry}><Text style={[typography.micro, { color: theme.colors.accent }]}>Retry</Text></Pressable></View> : null}
        {state.sessionStatusError ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{state.sessionStatusError}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry Chat statuses" onPress={() => void refreshSessionStatuses(displaySessions)}><Text style={[typography.micro, { color: theme.colors.accent }]}>Retry</Text></Pressable></View> : null}
        {labelSessionsError ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{labelSessionsError}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry loading labeled Chats" onPress={() => setLabelsReloadToken((value) => value + 1)}><Text style={[typography.micro, { color: theme.colors.accent }]}>Retry</Text></Pressable></View> : null}
      </View>
      <FlatList
        data={listItems}
        keyExtractor={(item) => item.kind === "remote" ? `remote:${item.hit.sessionId}` : `local:${item.session.id}`}
        renderItem={({ item }) => item.kind === "remote"
          ? <SessionSearchRow hit={item.hit} showSpace={false} onPress={(target) => onOpenSession(item.hit.sessionId, target)} />
          : <SessionRow session={item.session} showSpace={false} onPress={() => onOpenSession(item.session.id)} onLongPress={client ? () => openLabelSheet(item.session) : undefined} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24, flexGrow: listItems.length === 0 ? 1 : undefined }}
        ListFooterComponent={showLoadMore ? <View>{loadMoreError ? <Text selectable style={[typography.micro, { color: theme.colors.danger, marginHorizontal: 14, marginTop: 8 }]}>{loadMoreError}</Text> : null}<Pressable accessibilityRole="button" accessibilityLabel={loadMoreError ? "Retry loading Chats" : "Load more Chats"} disabled={loadingMore} onPress={() => void loadMore()} style={({ pressed }) => ({ minHeight: 40, marginHorizontal: 14, marginTop: 8, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}>{loadingMore ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>{loadMoreError ? "Retry loading Chats" : "Load more Chats"}</Text>}</Pressable></View> : null}
        ListEmptyComponent={<View style={styles.emptyPanel}>{emptyLoading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <AppIcon name={listFilter.kind === "label" ? "tag" : trimmedQuery ? "search" : "messages"} size={26} color={theme.colors.textMuted} />}<Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 10, textAlign: "center" }]}>{emptyLabel}</Text></View>}
      />
      {labelSheetSession && client ? <SessionLabelSheet client={client} spaceId={spaceId} session={labelSheetSession} labels={labels} labelsError={labelsError} onLabelsReload={() => setLabelsReloadToken((value) => value + 1)} onClose={closeLabelSheet} onChanged={() => { setLabelSessionIds(new Set()); setLabelsReloadToken((value) => value + 1); }} /> : null}
    </View>
  );
}

function PanelFilterChip({ label, icon, selected, onPress }: { label: string; icon?: React.ComponentProps<typeof AppIcon>["name"]; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => ({ minHeight: 32, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border, backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, flexDirection: "row", alignItems: "center", gap: 5 })}>{icon ? <AppIcon name={icon} size={13} color={selected ? theme.colors.accent : theme.colors.textMuted} /> : null}<Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
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
      {path ? <Pressable accessibilityRole="button" accessibilityLabel="Back to parent folder" onPress={() => setPath(parentSpacePath(path))} style={({ pressed }) => [styles.parentBar, { borderBottomColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}><AppIcon name="arrow-left" size={16} color={theme.colors.textMuted} /><Text style={[typography.caption, { color: theme.colors.textSecondary }]}>{parentSpacePath(path) ? `Back to ${spacePathName(parentSpacePath(path))}` : "Back to Files"}</Text></Pressable> : null}
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
