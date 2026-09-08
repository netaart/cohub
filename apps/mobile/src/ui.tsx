import { useRouter } from "expo-router";
import { type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ColorValue,
  type GestureResponderEvent,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { G, Path, Rect } from "react-native-svg";
import { icons, type IconName } from "@/src/icons";
import { getComposerActionState } from "@/src/data/composer-state";
import { useAppTheme, typography } from "@/src/theme";
import type { ActivityItem } from "@/src/data/types";
import { initials } from "@/src/utils";

export type { IconName } from "@/src/icons";

export function AppIcon({ name, size = 20, color, strokeWidth = 1.9, fill, style }: { name: IconName; size?: number; color?: ColorValue; strokeWidth?: number; fill?: string; style?: object }) {
  const theme = useAppTheme();
  const Icon = icons[name];
  return <Icon size={size} color={color ?? theme.colors.textSecondary} strokeWidth={strokeWidth} absoluteStrokeWidth style={style} {...(fill ? { fill } : {})} />;
}

export function CohubLogo({ size = 36 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 192 192">
      <Rect width={192} height={192} rx={32} fill="#ff4500" />
      <G transform="translate(0,192) scale(0.1,-0.1)" fill="#ffffff">
        <Path d="M853 1314 c-63 -23 -128 -86 -164 -160 -27 -54 -33 -79 -37 -157 -10 -196 63 -332 205 -383 53 -18 160 -17 219 3 92 31 184 151 184 240 0 21 -5 23 -45 23 -43 0 -45 -1 -55 -38 -13 -52 -48 -101 -89 -129 -27 -18 -48 -23 -98 -23 -77 0 -120 16 -156 60 -50 59 -61 96 -61 210 -1 89 3 113 22 155 28 61 47 82 95 107 48 24 152 26 195 4 36 -19 80 -69 88 -102 5 -21 12 -24 55 -24 27 0 49 4 49 8 0 5 -7 29 -16 55 -18 54 -74 115 -129 142 -54 25 -203 31 -262 9z" />
      </G>
    </Svg>
  );
}

export function BrandMark({ size = 36 }: { size?: number }) {
  return <CohubLogo size={size} />;
}

export function Avatar({ name, uri, size = 42, online = false }: { name: string; uri?: string | null; size?: number; online?: boolean }) {
  const theme = useAppTheme();
  return (
    <View style={{ width: size, height: size }}>
      {uri ? (
        <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 3.2, backgroundColor: theme.colors.surfaceRaised }} />
      ) : (
        <View style={{ width: size, height: size, borderRadius: size / 3.2, backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.accentBorder, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: theme.colors.accent, fontSize: Math.max(12, size * 0.32), fontWeight: "700" }}>{initials(name)}</Text>
        </View>
      )}
      {online ? <View style={{ position: "absolute", right: -1, bottom: -1, width: 12, height: 12, borderRadius: 6, backgroundColor: theme.colors.success, borderWidth: 2, borderColor: theme.colors.background }} /> : null}
    </View>
  );
}

export function IconButton({ name, onPress, label, size = 42, tone = "default", disabled = false }: { name: IconName; onPress: (event: GestureResponderEvent) => void; label: string; size?: number; tone?: "default" | "accent" | "danger"; disabled?: boolean }) {
  const theme = useAppTheme();
  const color = tone === "accent" ? theme.colors.accent : tone === "danger" ? theme.colors.danger : theme.colors.textSecondary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      disabled={disabled}
      onPress={onPress}
     
      style={({ pressed }) => [styles.iconButton, { width: size, height: size, borderRadius: size / 2, backgroundColor: pressed ? (tone === "accent" ? theme.colors.accentSoft : theme.colors.surfacePressed) : "transparent", opacity: disabled ? 0.45 : 1 }]}
    >
      <AppIcon name={name} size={size * 0.48} color={color} />
    </Pressable>
  );
}

export function Screen({ children, scroll = false, refreshing = false, onRefresh, contentStyle, keyboard = false }: { children: ReactNode; scroll?: boolean; refreshing?: boolean; onRefresh?: () => void; contentStyle?: ViewStyle; keyboard?: boolean }) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const body = scroll ? (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={[{ paddingBottom: insets.bottom + 28 }, contentStyle]}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.accent} colors={[theme.colors.accent]} /> : undefined}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1, backgroundColor: theme.colors.background }, contentStyle]}>{children}</View>
  );
  const wrapped = keyboard ? <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>{body}</KeyboardAvoidingView> : body;
  return <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: theme.colors.background }}>{wrapped}</View>;
}

export function WorkspaceToolbar({ query, onQueryChange, queryRef, onAccount, onCreate, onSettings, placeholder = "Search Chats and Spaces" }: { query: string; onQueryChange: (value: string) => void; queryRef?: React.RefObject<TextInput | null>; onAccount: () => void; onCreate: () => void; onSettings: () => void; placeholder?: string }) {
  const theme = useAppTheme();
  return <View style={[styles.workspaceToolbar, { borderBottomColor: theme.colors.border }]}>
    <Pressable accessibilityRole="button" accessibilityLabel="Open account" onPress={onAccount} hitSlop={5} style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}><BrandMark size={40} /></Pressable>
    <View style={{ flex: 1, minWidth: 0 }}><SearchField inputRef={queryRef} value={query} onChangeText={onQueryChange} placeholder={placeholder} /></View>
    <IconButton name="plus" label="Create new" size={42} tone="accent" onPress={onCreate} />
    <IconButton name="settings" label="Open settings" size={42} onPress={onSettings} />
  </View>;
}

export function TopBar({ title, subtitle, left, right }: { title: string; subtitle?: string; left?: ReactNode; right?: ReactNode }) {
  const theme = useAppTheme();
  return (
    <View testID="app-top-bar" style={[styles.topBar, { borderBottomColor: theme.colors.border }]}>
      <View style={styles.topBarLeft}>{left}</View>
      <View style={styles.topBarTitle}>
        <Text numberOfLines={1} style={[typography.heading, { color: theme.colors.text }]}>{title}</Text>
        {subtitle ? <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 1 }]}>{subtitle}</Text> : null}
      </View>
      <View style={styles.topBarRight}>{right}</View>
    </View>
  );
}

export function DetailTopBar({ title, subtitle, onBack, backLabel = "Back", actions }: { title: string; subtitle?: string; onBack: () => void; backLabel?: string; actions?: ReactNode }) {
  const theme = useAppTheme();
  return (
    <View testID="app-detail-top-bar" style={[styles.detailTopBar, { borderBottomColor: theme.colors.border, backgroundColor: theme.colors.background }]}>
      <IconButton name="arrow-left" label={backLabel} size={40} onPress={onBack} />
      <View style={styles.detailTopBarTitle}>
        <Text accessibilityRole="header" numberOfLines={1} style={[typography.heading, { color: theme.colors.text }]}>{title}</Text>
        {subtitle ? <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textSecondary, marginTop: 1 }]}>{subtitle}</Text> : null}
      </View>
      {actions ? <View style={styles.detailTopBarActions}>{actions}</View> : null}
    </View>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const theme = useAppTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[typography.eyebrow, { color: theme.colors.textMuted, textTransform: "uppercase" }]}>{title}</Text>
      {action && onAction ? <Pressable onPress={onAction} hitSlop={8}><Text style={[typography.caption, { color: theme.colors.accent }]}>{action}</Text></Pressable> : null}
    </View>
  );
}

export function StatusPill({ label, tone = "neutral", dot = true }: { label: string; tone?: "neutral" | "success" | "warning" | "danger" | "info"; dot?: boolean }) {
  const theme = useAppTheme();
  const values = {
    neutral: { fg: theme.colors.textMuted, bg: theme.colors.surfaceRaised },
    success: { fg: theme.colors.success, bg: theme.colors.successSoft },
    warning: { fg: theme.colors.warning, bg: theme.colors.warningSoft },
    danger: { fg: theme.colors.danger, bg: theme.colors.dangerSoft },
    info: { fg: theme.colors.info, bg: theme.colors.infoSoft },
  }[tone];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: values.bg }}>
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: values.fg }} /> : null}
      <Text style={[typography.micro, { color: values.fg }]}>{label}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, description, action, onAction }: { icon: IconName; title: string; description: string; action?: string; onAction?: () => void }) {
  const theme = useAppTheme();
  return (
    <View style={styles.emptyState}>
      <View style={[styles.emptyIcon, { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accentBorder }]}><AppIcon name={icon} size={24} color={theme.colors.accent} /></View>
      <Text style={[typography.heading, { color: theme.colors.text, marginTop: 14, textAlign: "center" }]}>{title}</Text>
      <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 6, textAlign: "center", maxWidth: 300 }]}>{description}</Text>
      {action && onAction ? <PrimaryButton label={action} onPress={onAction} style={{ marginTop: 18 }} /> : null}
    </View>
  );
}

export function PrimaryButton({ label, onPress, icon, loading = false, disabled = false, tone = "accent", style }: { label: string; onPress: () => void; icon?: IconName; loading?: boolean; disabled?: boolean; tone?: "accent" | "danger"; style?: ViewStyle }) {
  const theme = useAppTheme();
  const color = tone === "danger" ? theme.colors.danger : theme.colors.accent;
  const pressedColor = tone === "danger" ? theme.colors.danger : theme.colors.accentPressed;
  const foreground = tone === "danger" ? theme.colors.dangerText : theme.colors.accentText;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [styles.primaryButton, { backgroundColor: pressed ? pressedColor : color, opacity: disabled || loading ? 0.55 : 1 }, style]}>
      {loading ? <ActivityIndicator color={foreground} size="small" /> : icon ? <AppIcon name={icon} size={17} color={foreground} /> : null}
      <Text style={[typography.bodyMedium, { color: foreground }]}>{label}</Text>
    </Pressable>
  );
}

export function SearchField({ value, onChangeText, placeholder = "Search", inputRef }: Pick<TextInputProps, "value" | "onChangeText" | "placeholder"> & { inputRef?: React.RefObject<TextInput | null> }) {
  const theme = useAppTheme();
  return (
    <View style={[styles.searchField, { backgroundColor: theme.colors.surfaceRaised }]}>
      <AppIcon name="search" size={18} color={theme.colors.textMuted} />
      <TextInput ref={inputRef} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={theme.colors.textFaint} style={[typography.body, { flex: 1, color: theme.colors.text, paddingVertical: 0 }]} returnKeyType="search" />
      {value ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => onChangeText?.("")} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}><AppIcon name="circle-x" size={17} color={theme.colors.textFaint} /></Pressable> : null}
    </View>
  );
}

export function LoadingRows({ count = 5 }: { count?: number }) {
  const theme = useAppTheme();
  return <View style={{ paddingHorizontal: 16, gap: 4 }}>{Array.from({ length: count }).map((_, index) => <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}><View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: theme.colors.surfaceRaised }} /><View style={{ flex: 1, gap: 9 }}><View style={{ width: `${58 + (index % 3) * 10}%`, height: 12, borderRadius: 6, backgroundColor: theme.colors.surfaceRaised }} /><View style={{ width: `${38 + (index % 2) * 15}%`, height: 10, borderRadius: 5, backgroundColor: theme.colors.surfaceRaised }} /></View></View>)}</View>;
}

export function ComposerInput({ value, onChangeText, onSend, onStop, onAttach, onVoice, onModelPress, modelLabel = "Automatic", modelStatus = "unknown", disabled = false, sending = false, running = false, voiceActive = false, voiceStarting = false, hasAttachment = false, placeholder = "Message the Agent" }: { value: string; onChangeText: (value: string) => void; onSend: () => void; onStop?: () => void; onAttach: () => void; onVoice?: () => void; onModelPress?: () => void; modelLabel?: string; modelStatus?: "available" | "degraded" | "outage" | "unknown"; disabled?: boolean; sending?: boolean; running?: boolean; voiceActive?: boolean; voiceStarting?: boolean; hasAttachment?: boolean; placeholder?: string }) {
  const theme = useAppTheme();
  const { blocked, canSend, canStop } = getComposerActionState({ text: value, hasAttachment, disabled, sending, running, hasStopHandler: Boolean(onStop) });
  const modelStatusLabel = modelStatus === "available" ? "operational" : modelStatus === "degraded" ? "degraded" : modelStatus === "outage" ? "outage" : "status unavailable";
  return (
    <View style={[styles.composerWrap, { borderTopColor: theme.colors.border, backgroundColor: theme.colors.background }]}>
      <View style={[styles.composer, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          editable={!blocked}
          multiline
          maxLength={12000}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textFaint}
          style={[typography.body, styles.composerText, { color: theme.colors.text }]}
          onSubmitEditing={(event) => {
            if (Platform.OS === "web" && canSend) {
              event.preventDefault();
              onSend();
            }
          }}
          blurOnSubmit={false}
        />
        <View style={styles.composerToolbar}>
          <IconButton name="plus" label="Add attachment" size={34} onPress={onAttach} disabled={blocked} />
          <View style={styles.composerToolbarSpacer} />
          {onModelPress ? <Pressable accessibilityRole="button" accessibilityLabel={`Choose model, ${modelLabel}, ${modelStatusLabel}`} disabled={blocked} onPress={onModelPress} style={({ pressed }) => [styles.composerModel, { backgroundColor: pressed ? theme.colors.surfacePressed : "transparent", opacity: blocked ? 0.5 : 1 }]}><AppIcon name="zap" size={14} color={theme.colors.accent} /><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: modelStatus === "available" ? theme.colors.success : modelStatus === "degraded" ? theme.colors.warning : modelStatus === "outage" ? theme.colors.danger : theme.colors.textFaint }} /><Text numberOfLines={1} style={[typography.micro, { color: theme.colors.textSecondary, flexShrink: 1 }]}>{modelLabel}</Text><AppIcon name="chevron-down" size={13} color={theme.colors.textMuted} /></Pressable> : null}
          {onVoice ? <Pressable accessibilityRole="button" accessibilityLabel={voiceActive ? "Stop voice input" : "Start voice input"} disabled={blocked || voiceStarting} onPress={onVoice} style={({ pressed }) => [styles.voiceButton, { backgroundColor: voiceActive ? (pressed ? theme.colors.accentBorder : theme.colors.accentSoft) : pressed ? theme.colors.surfacePressed : "transparent", borderColor: voiceActive ? theme.colors.accentBorder : "transparent" }]}><AppIcon name={voiceActive ? "mic" : voiceStarting ? "more" : "mic"} size={17} color={voiceActive ? theme.colors.accent : theme.colors.textMuted} /></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={canStop ? "Stop generation" : "Send message"} disabled={!canStop && !canSend} onPress={() => { if (canStop) onStop?.(); else onSend(); }} style={({ pressed }) => [styles.sendButton, { backgroundColor: canStop ? (pressed ? theme.colors.textSecondary : theme.colors.text) : canSend ? (pressed ? theme.colors.accentPressed : theme.colors.accent) : theme.colors.surfaceRaised }]}>
            <AppIcon name={canStop ? "stop" : "arrow-up"} size={canStop ? 15 : 18} color={canStop ? theme.colors.background : canSend ? theme.colors.accentText : theme.colors.textFaint} fill={canStop ? theme.colors.background : undefined} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function AttachmentChip({ name, onRemove }: { name: string; onRemove: () => void }) {
  const theme = useAppTheme();
  return <View style={[styles.attachmentChip, { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accentBorder }]}><AppIcon name="file-text" size={15} color={theme.colors.accent} /><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.text, flex: 1 }]}>{name}</Text><Pressable onPress={onRemove} hitSlop={8}><AppIcon name="x" size={15} color={theme.colors.textMuted} /></Pressable></View>;
}

export function ConnectionBanner({ state }: { state: string }) {
  const theme = useAppTheme();
  if (state === "open" || state === "idle") return null;
  const reconnecting = state === "reconnecting" || state === "connecting";
  return <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingVertical: 8, backgroundColor: reconnecting ? theme.colors.warningSoft : theme.colors.dangerSoft }}><AppIcon name={reconnecting ? "sync" : "cloud-off"} size={14} color={reconnecting ? theme.colors.warning : theme.colors.danger} /><Text style={[typography.caption, { color: reconnecting ? theme.colors.warning : theme.colors.danger }]}>{reconnecting ? "Reconnecting to Cohub" : "Connection unavailable"}</Text></View>;
}

export function DataError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const theme = useAppTheme();
  return <View style={[styles.dataError, { backgroundColor: theme.colors.dangerSoft, borderColor: theme.colors.danger }]}><View style={[styles.dataErrorIcon, { backgroundColor: theme.colors.background }]}><AppIcon name="cloud-off" size={17} color={theme.colors.danger} /></View><View style={{ flex: 1, minWidth: 0 }}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>Could not load your data</Text><Text selectable style={[typography.caption, { color: theme.colors.danger, marginTop: 3 }]}>{message}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Retry loading data" onPress={onRetry} hitSlop={8}><Text style={[typography.bodyMedium, { color: theme.colors.danger }]}>Retry</Text></Pressable></View>;
}

export function getStatusTone(status: ActivityItem["status"]): "success" | "warning" | "danger" | "neutral" {
  return status === "running" ? "warning" : status === "failed" ? "danger" : status === "stopped" ? "neutral" : "success";
}

export function useBackButton() {
  return useRouter();
}

const styles = StyleSheet.create({
  iconButton: { alignItems: "center", justifyContent: "center" },
  workspaceToolbar: { minHeight: 66, paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  topBar: { height: 66, minHeight: 66, maxHeight: 66, flexShrink: 0, paddingHorizontal: 16, paddingVertical: 7, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth },
  topBarLeft: { width: 44, height: 42, alignItems: "flex-start", justifyContent: "center" },
  topBarTitle: { flex: 1, minWidth: 0, height: 42, justifyContent: "center", paddingVertical: 2 },
  topBarRight: { width: 96, height: 42, alignItems: "flex-end", justifyContent: "center", flexDirection: "row", gap: 2 },
  detailTopBar: { height: 66, minHeight: 66, maxHeight: 66, flexShrink: 0, paddingHorizontal: 8, paddingVertical: 5, flexDirection: "row", alignItems: "center", gap: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  detailTopBarTitle: { flex: 1, minWidth: 0, height: 42, justifyContent: "center", paddingHorizontal: 2 },
  detailTopBarActions: { height: 42, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 0 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingTop: 22, paddingBottom: 10 },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, minHeight: 260 },
  emptyIcon: { width: 56, height: 56, borderRadius: 18, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  dataError: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginTop: 12, padding: 12, borderWidth: 1, borderRadius: 14 },
  dataErrorIcon: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  primaryButton: { minHeight: 46, paddingHorizontal: 18, borderRadius: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  searchField: { minHeight: 44, borderRadius: 12, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 9 },
  composerWrap: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, borderTopWidth: 1 },
  composer: { minHeight: 84, borderWidth: 1, borderRadius: 14, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 5, gap: 2 },
  composerText: { width: "100%", minHeight: 34, maxHeight: 120, paddingHorizontal: 5, paddingTop: 0, paddingBottom: 4, textAlignVertical: "top" },
  composerToolbar: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 3 },
  composerToolbarSpacer: { flex: 1, minWidth: 0 },
  composerModel: { minHeight: 30, maxWidth: "58%", paddingHorizontal: 5, borderRadius: 9, flexDirection: "row", alignItems: "center", gap: 5, overflow: "hidden" },
  sendButton: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  voiceButton: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: "center", justifyContent: "center", marginBottom: 2 },
  attachmentChip: { flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 7, maxWidth: "100%" },
});
