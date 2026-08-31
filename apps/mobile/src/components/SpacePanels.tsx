/* eslint-disable react-hooks/refs -- PanResponder needs stable mutable gesture state. */
import type { CohubClient, SpaceFsEntry, UserSessionListItem } from "@neta-art/cohub";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionRow } from "@/src/components/SessionRow";
import { SpaceFileRow } from "@/src/components/SpaceFileRow";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, IconButton, PrimaryButton } from "@/src/ui";
import { normalizeSpacePath, parentSpacePath, spacePathName } from "@/src/utils";

export type SpacePanel = "chat" | "files";

type SpacePanelsProps = {
  spaceId: string;
  spaceName: string;
  sessions: UserSessionListItem[];
  client: CohubClient | null;
  activePanel: SpacePanel | null;
  onActivePanelChange: (panel: SpacePanel | null) => void;
  onOpenSession: (sessionId: string) => void;
  onNewChat: () => void;
  onOpenFile: (path: string) => void;
  onOpenFilesPage: () => void;
  children: ReactNode;
};

const EDGE_ZONE_PX = 44;
const PANEL_WIDTH_RATIO = 0.86;
const MAX_PANEL_WIDTH = 360;
const OPEN_THRESHOLD = 0.26;
const CLOSE_THRESHOLD = 0.5;
const ANIMATION_DURATION_MS = 220;
const USE_NATIVE_DRIVER = Platform.OS !== "web";

type GestureController = {
  activePanel: SpacePanel | null;
  visibleSide: SpacePanel | null;
  gestureSide: SpacePanel | null;
  gestureDistance: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function SpacePanels({
  spaceId,
  spaceName,
  sessions,
  client,
  activePanel,
  onActivePanelChange,
  onOpenSession,
  onNewChat,
  onOpenFile,
  onOpenFilesPage,
  children,
}: SpacePanelsProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const panelWidth = Math.min(MAX_PANEL_WIDTH, Math.max(280, width * PANEL_WIDTH_RATIO));
  const [progress] = useState(() => new Animated.Value(0));
  const controllerRef = useRef<GestureController>({
    activePanel,
    visibleSide: activePanel,
    gestureSide: null,
    gestureDistance: 0,
  });
  const [closingSide, setClosingSide] = useState<SpacePanel | null>(null);

  useEffect(() => {
    controllerRef.current.activePanel = activePanel;
  }, [activePanel]);

  const animateTo = useCallback((value: number, onFinished?: () => void) => {
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: value,
      duration: ANIMATION_DURATION_MS,
      useNativeDriver: USE_NATIVE_DRIVER,
    }).start(({ finished }) => {
      if (finished) onFinished?.();
    });
  }, [progress]);

  useEffect(() => {
    if (!activePanel) return;
    controllerRef.current.activePanel = activePanel;
    controllerRef.current.visibleSide = activePanel;
    progress.stopAnimation();
    progress.setValue(0);
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

  const visibleSide = activePanel ?? closingSide;
  const drawerMounted = visibleSide !== null;

  // Do not mount the native Modal until release; changing native roots mid-touch can cancel the edge responder.
  const edgeResponder = useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, gesture) => {
        if (controllerRef.current.activePanel || controllerRef.current.visibleSide) return false;
        const fromLeft = gesture.x0 <= EDGE_ZONE_PX && gesture.dx > 8;
        const fromRight = gesture.x0 >= width - EDGE_ZONE_PX && gesture.dx < -8;
        return (fromLeft || fromRight) && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.25;
      },
      onPanResponderGrant: (_, gesture) => {
        const side: SpacePanel = gesture.x0 <= EDGE_ZONE_PX ? "chat" : "files";
        controllerRef.current.gestureSide = side;
        controllerRef.current.gestureDistance = 0;
        controllerRef.current.visibleSide = side;
        setClosingSide(null);
        progress.stopAnimation();
        progress.setValue(0);
      },
      onPanResponderMove: (_, gesture) => {
        const side = controllerRef.current.gestureSide;
        if (!side) return;
        const distance = side === "chat" ? Math.max(0, gesture.dx) : Math.max(0, -gesture.dx);
        controllerRef.current.gestureDistance = distance;
        progress.setValue(clamp(distance / panelWidth, 0, 1));
      },
      onPanResponderRelease: (_, gesture) => {
        const side = controllerRef.current.gestureSide;
        if (!side) return;
        const distance = controllerRef.current.gestureDistance;
        const velocity = side === "chat" ? gesture.vx : -gesture.vx;
        controllerRef.current.gestureSide = null;
        if (distance / panelWidth >= OPEN_THRESHOLD || velocity >= 0.55) {
          onActivePanelChange(side);
        } else {
          progress.stopAnimation();
          progress.setValue(0);
          controllerRef.current.visibleSide = null;
        }
      },
      onPanResponderTerminate: () => {
        controllerRef.current.gestureSide = null;
        progress.stopAnimation();
        progress.setValue(0);
        controllerRef.current.visibleSide = null;
      },
      onPanResponderTerminationRequest: () => false,
    }),
    [onActivePanelChange, panelWidth, progress, width],
  );

  const panelResponder = useMemo(
    () => PanResponder.create({
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
        const side = controllerRef.current.visibleSide;
        if (!side) return;
        const distance = side === "chat" ? Math.max(0, -gesture.dx) : Math.max(0, gesture.dx);
        const velocity = side === "chat" ? -gesture.vx : gesture.vx;
        if (distance / panelWidth >= CLOSE_THRESHOLD || velocity >= 0.55) {
          closeDrawer();
        } else {
          animateTo(1);
        }
      },
      onPanResponderTerminate: () => animateTo(1),
      onPanResponderTerminationRequest: () => false,
    }),
    [animateTo, closeDrawer, panelWidth, progress],
  );

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: visibleSide === "files" ? [panelWidth, 0] : [-panelWidth, 0],
  });
  const backdropOpacity = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 0.52] });

  return (
    <View style={{ flex: 1 }} {...edgeResponder.panHandlers}>
      {children}
      <View pointerEvents="none" style={styles.edgeHints}>
        <View style={[styles.edgeHint, styles.leftHint, { backgroundColor: theme.colors.borderStrong }]} />
        <View style={[styles.edgeHint, styles.rightHint, { backgroundColor: theme.colors.borderStrong }]} />
      </View>
      <Modal
        visible={drawerMounted}
        transparent
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
        hardwareAccelerated
        onRequestClose={closeDrawer}
      >
        <View style={styles.modalRoot}>
          <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close panel" style={styles.fill} onPress={closeDrawer} />
          </Animated.View>
          <Animated.View
            {...panelResponder.panHandlers}
            accessibilityViewIsModal
            role="dialog"
            style={[
              styles.panel,
              {
                width: panelWidth,
                height: Math.max(0, height),
                paddingTop: insets.top,
                paddingBottom: insets.bottom,
                backgroundColor: theme.colors.background,
                borderColor: theme.colors.border,
                left: visibleSide === "chat" ? 0 : undefined,
                right: visibleSide === "files" ? 0 : undefined,
                transform: [{ translateX }],
              },
            ]}
          >
            {visibleSide === "chat" ? (
              <ChatPanel
                spaceName={spaceName}
                sessions={sessions}
                onClose={closeDrawer}
                onNewChat={() => {
                  closeDrawer();
                  onNewChat();
                }}
                onOpenSession={(sessionId) => {
                  closeDrawer();
                  onOpenSession(sessionId);
                }}
              />
            ) : (
              <FilesPanel
                spaceId={spaceId}
                spaceName={spaceName}
                client={client}
                onClose={closeDrawer}
                onOpenFile={(path) => {
                  closeDrawer();
                  onOpenFile(path);
                }}
                onOpenFilesPage={() => {
                  closeDrawer();
                  onOpenFilesPage();
                }}
              />
            )}
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
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

function ChatPanel({
  spaceName,
  sessions,
  onClose,
  onNewChat,
  onOpenSession,
}: {
  spaceName: string;
  sessions: UserSessionListItem[];
  onClose: () => void;
  onNewChat: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const theme = useAppTheme();
  const displaySessions = sessions.map((session) => session.space ? session : {
    ...session,
    space: { id: session.spaceId, name: spaceName, slug: null, publicProfile: null },
  });
  return (
    <View style={styles.panelContent}>
      <PanelHeader title="Chats" subtitle={spaceName} onClose={onClose} />
      <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
        <PrimaryButton label="New Chat" icon="plus" onPress={onNewChat} style={{ minHeight: 44 }} />
      </View>
      <FlatList
        data={displaySessions}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <SessionRow session={item} onPress={() => onOpenSession(item.id)} />}
        contentContainerStyle={{ paddingBottom: 24, flexGrow: displaySessions.length === 0 ? 1 : undefined }}
        ListEmptyComponent={<View style={styles.emptyPanel}><AppIcon name="messages" size={26} color={theme.colors.textMuted} /><Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 10, textAlign: "center" }]}>No Chats in this Space yet.</Text></View>}
      />
    </View>
  );
}

function FilesPanel({
  spaceId,
  spaceName,
  client,
  onClose,
  onOpenFile,
  onOpenFilesPage,
}: {
  spaceId: string;
  spaceName: string;
  client: CohubClient | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenFilesPage: () => void;
}) {
  const theme = useAppTheme();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<SpaceFsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
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
  }, [client, path, spaceId]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      requestIdRef.current += 1;
    };
  }, [load]);

  const openEntry = (entry: SpaceFsEntry) => {
    if (entry.type === "dir") {
      setPath(normalizeSpacePath(entry.path));
      return;
    }
    onOpenFile(entry.path);
  };

  return (
    <View style={styles.panelContent}>
      <PanelHeader
        title={path ? spacePathName(path) : "Files"}
        subtitle={path ? `${spaceName} / ${path}` : spaceName}
        onClose={onClose}
        action={<IconButton name="external-link" label="Open full Files" size={36} onPress={onOpenFilesPage} />}
      />
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
          ListEmptyComponent={<View style={styles.emptyPanel}><AppIcon name="folder-open" size={26} color={theme.colors.textMuted} /><Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 10 }]}>{path ? "This folder is empty." : "This workspace is empty."}</Text></View>}
        />
      )}
    </View>
  );
}

const styles = {
  modalRoot: { flex: 1 } as const,
  fill: { flex: 1 } as const,
  backdrop: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "#000000" },
  panel: { position: "absolute" as const, top: 0, bottom: 0, borderLeftWidth: 1, borderRightWidth: 1, shadowColor: "#000000", shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.25, shadowRadius: 18, elevation: 12 },
  panelContent: { flex: 1, minHeight: 0 },
  header: { minHeight: 62, paddingHorizontal: 10, paddingVertical: 7, flexDirection: "row" as const, alignItems: "center" as const, gap: 5, borderBottomWidth: 1 },
  headerText: { flex: 1, minWidth: 0, paddingHorizontal: 3 },
  emptyPanel: { flex: 1, minHeight: 180, alignItems: "center" as const, justifyContent: "center" as const, padding: 24 },
  parentBar: { minHeight: 40, paddingHorizontal: 14, flexDirection: "row" as const, alignItems: "center" as const, gap: 8, borderBottomWidth: 1 },
  edgeHints: { position: "absolute" as const, top: 0, bottom: 0, left: 0, right: 0 },
  edgeHint: { position: "absolute" as const, top: "44%" as const, width: 3, height: 48, borderRadius: 2, opacity: 0.45 },
  leftHint: { left: 1 },
  rightHint: { right: 1 },
} satisfies Record<string, object>;
