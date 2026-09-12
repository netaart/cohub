import { useRouter } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
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
import { COMPOSER_TEXT_PADDING, getComposerLayout } from "@/src/ui/composer-layout";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import type { ActivityItem } from "@/src/data/types";
import { initials } from "@/src/utils";

export { ExpandableSearchBar } from "@/src/ui/ExpandableSearchBar";
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

export function IconButton({ name, onPress, label, size = 44, tone = "default", disabled = false }: { name: IconName; onPress: (event: GestureResponderEvent) => void; label: string; size?: number; tone?: "default" | "accent" | "danger"; disabled?: boolean }) {
  const theme = useAppTheme();
  const color = tone === "accent" ? theme.colors.accent : tone === "danger" ? theme.colors.danger : theme.colors.textSecondary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      disabled={disabled}
      onPress={onPress}
     
      style={({ pressed }) => [styles.iconButton, { width: Math.max(44, size), height: Math.max(44, size), borderRadius: Math.max(44, size) / 2, backgroundColor: pressed ? (tone === "accent" ? theme.colors.accentSoft : theme.colors.surfacePressed) : "transparent", opacity: disabled ? 0.45 : 1 }]}
    >
      <AppIcon name={name} size={size * 0.48} color={color} />
    </Pressable>
  );
}

export function Screen({ children, scroll = false, refreshing = false, onRefresh, contentStyle, keyboard = false, scrollRef }: { children: ReactNode; scroll?: boolean; refreshing?: boolean; onRefresh?: () => void; contentStyle?: ViewStyle; keyboard?: boolean; scrollRef?: React.RefObject<ScrollView | null> }) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const body = scroll ? (
    <ScrollView
      ref={scrollRef}
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

type TopBarProps = {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  backLabel?: string;
  leading?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
};

export function TopBar({ title, subtitle, onBack, backLabel, leading, actions, children }: TopBarProps) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return (
    <View testID="app-top-bar" style={[styles.topBar, { backgroundColor: theme.colors.background }]}>
      {onBack ? <IconButton name="arrow-left" label={backLabel ?? t("ui.detail.back")} onPress={onBack} /> : leading ? <View style={styles.topBarLeading}>{leading}</View> : null}
      <View style={styles.topBarTitle}>
        {children ?? <>
          <Text accessibilityRole="header" numberOfLines={1} style={[typography.heading, { color: theme.colors.text }]}>{title}</Text>
          {subtitle ? <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textSecondary, marginTop: 1 }]}>{subtitle}</Text> : null}
        </>}
      </View>
      {actions ? <View style={styles.topBarActions}>{actions}</View> : null}
    </View>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: { icon: IconName; label: string; onPress: () => void } }) {
  const theme = useAppTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text accessibilityRole="header" style={[typography.eyebrow, { flex: 1, color: theme.colors.textMuted, letterSpacing: 0, textTransform: "uppercase" }]}>{title}</Text>
      {action ? <IconButton name={action.icon} label={action.label} onPress={action.onPress} tone="accent" /> : null}
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

export function EmptyState({ icon, title, description, action }: { icon: IconName; title: string; description?: string; action?: { icon: IconName; label: string; onPress: () => void } }) {
  const theme = useAppTheme();
  return (
    <View style={styles.emptyState}>
      <AppIcon name={icon} size={28} color={theme.colors.textMuted} />
      <Text style={[typography.heading, { color: theme.colors.text, marginTop: 14, textAlign: "center" }]}>{title}</Text>
      {description ? <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 6, textAlign: "center", maxWidth: 300 }]}>{description}</Text> : null}
      {action ? <View style={{ marginTop: 12 }}><IconButton name={action.icon} label={action.label} onPress={action.onPress} tone="accent" /></View> : null}
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

export function SearchField({ value, onChangeText, placeholder, inputRef }: Pick<TextInputProps, "value" | "onChangeText" | "placeholder"> & { inputRef?: React.RefObject<TextInput | null> }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.searchField, { backgroundColor: theme.colors.surfaceRaised }]}>
      <AppIcon name="search" size={18} color={theme.colors.textMuted} />
      <TextInput ref={inputRef} value={value} onChangeText={onChangeText} placeholder={placeholder ?? t("ui.search.placeholder")} placeholderTextColor={theme.colors.textFaint} style={[typography.body, { flex: 1, color: theme.colors.text, paddingVertical: 0 }]} returnKeyType="search" />
      {value ? <Pressable accessibilityRole="button" accessibilityLabel={t("ui.search.clear")} onPress={() => onChangeText?.("")} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}><AppIcon name="circle-x" size={17} color={theme.colors.textFaint} /></Pressable> : null}
    </View>
  );
}

export function LoadingRows({ count = 5 }: { count?: number }) {
  const theme = useAppTheme();
  return <View style={{ paddingHorizontal: 16, gap: 4 }}>{Array.from({ length: count }).map((_, index) => <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}><View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: theme.colors.surfaceRaised }} /><View style={{ flex: 1, gap: 9 }}><View style={{ width: `${58 + (index % 3) * 10}%`, height: 12, borderRadius: 6, backgroundColor: theme.colors.surfaceRaised }} /><View style={{ width: `${38 + (index % 2) * 15}%`, height: 10, borderRadius: 5, backgroundColor: theme.colors.surfaceRaised }} /></View></View>)}</View>;
}

export function ComposerInput({ value, onChangeText, onSend, onStop, onAttach, onVoice, onModelPress, modelLabel, modelStatus = "unknown", disabled = false, sending = false, running = false, voiceActive = false, voiceStarting = false, hasAttachment = false, placeholder, anchorRef, attachmentMenuOpen = false, modelMenuOpen = false }: { value: string; onChangeText: (value: string) => void; onSend: () => void; onStop?: () => void; onAttach: () => void; onVoice?: () => void; onModelPress?: () => void; modelLabel?: string; modelStatus?: "available" | "degraded" | "outage" | "unknown"; disabled?: boolean; sending?: boolean; running?: boolean; voiceActive?: boolean; voiceStarting?: boolean; hasAttachment?: boolean; placeholder?: string; anchorRef?: React.RefObject<View | null>; attachmentMenuOpen?: boolean; modelMenuOpen?: boolean }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const [focused, setFocused] = useState(false);
  const [keyboardTop, setKeyboardTop] = useState<number | null>(() => Keyboard.metrics()?.screenY ?? null);
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const keyboardVisible = keyboardTop !== null;
  // Android keeps its bottom safe-area inset while KeyboardAvoidingView is active.
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, (event) => setKeyboardTop(event.endCoordinates.screenY));
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardTop(null));
    return () => { show.remove(); hide.remove(); };
  }, []);
  if (!value && expanded) setExpanded(false);
  const { blocked, canSend, canStop } = getComposerActionState({ text: value, hasAttachment, disabled, sending, running, hasStopHandler: Boolean(onStop) });
  const layout = getComposerLayout({
    text: value,
    contentHeight,
    lineHeight: typography.body.lineHeight * fontScale,
    availableHeight: Math.min(windowHeight, keyboardTop ?? windowHeight) - insets.top - (keyboardVisible ? 0 : insets.bottom),
    expanded,
  });
  const resolvedModelLabel = modelLabel ?? t("ui.composer.modelAutomatic");
  const modelStatusLabel = modelStatus === "available" ? t("ui.modelStatus.available") : modelStatus === "degraded" ? t("ui.modelStatus.degraded") : modelStatus === "outage" ? t("ui.modelStatus.outage") : t("ui.modelStatus.unknown");
  return (
    <View style={[styles.composerWrap, { paddingBottom: (Platform.OS === "android" && keyboardVisible ? 0 : insets.bottom) + 10 }]}>
      <View ref={anchorRef} collapsable={false} testID="chat-composer" style={[styles.composer, { backgroundColor: theme.colors.surface, borderColor: focused ? theme.colors.borderStrong : theme.colors.border }]}>
        <View style={styles.composerInputRow}>
          <TextInput
            testID="chat-composer-input"
            accessibilityLabel={t("ui.composer.placeholder")}
            value={value}
            onChangeText={onChangeText}
            onContentSizeChange={(event) => setContentHeight(event.nativeEvent.contentSize.height)}
            editable={!blocked}
            multiline
            scrollEnabled={layout.scrollEnabled}
            maxLength={12000}
            placeholder={placeholder ?? t("ui.composer.placeholder")}
            placeholderTextColor={theme.colors.textFaint}
            style={[typography.body, styles.composerText, { color: theme.colors.text, height: layout.height }]}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            submitBehavior="newline"
          />
          <View style={styles.composerExpandSlot}>
            {layout.showExpandButton ? <Pressable
              testID="chat-composer-expand"
              accessibilityRole="button"
              accessibilityLabel={t(layout.expanded ? "ui.composer.collapse" : "ui.composer.expand")}
              accessibilityState={{ expanded: layout.expanded }}
              onPress={() => setExpanded(!layout.expanded)}
              style={({ pressed }) => [styles.composerExpandButton, { backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}
            ><AppIcon name={layout.expanded ? "minimize" : "maximize"} size={17} color={theme.colors.textMuted} /></Pressable> : null}
          </View>
        </View>
        <View style={styles.composerToolbar}>
          <Pressable testID="chat-composer-attach" accessibilityRole="button" accessibilityLabel={t("ui.composer.addAttachment")} accessibilityState={{ expanded: attachmentMenuOpen, disabled: blocked }} disabled={blocked} onPress={() => { Keyboard.dismiss(); onAttach(); }} style={({ pressed }) => [styles.composerCircleButton, { backgroundColor: pressed || attachmentMenuOpen ? theme.colors.surfacePressed : theme.colors.surfaceRaised, opacity: blocked ? 0.45 : 1 }]}><AppIcon name={attachmentMenuOpen ? "x" : "plus"} size={22} color={theme.colors.textSecondary} /></Pressable>
          {onModelPress ? <Pressable testID="chat-composer-model" accessibilityRole="button" accessibilityLabel={t("ui.composer.chooseModel", { model: resolvedModelLabel, status: modelStatusLabel })} accessibilityState={{ expanded: modelMenuOpen, disabled: blocked }} disabled={blocked} onPress={() => { Keyboard.dismiss(); onModelPress(); }} style={({ pressed }) => [styles.composerModel, { backgroundColor: pressed || modelMenuOpen ? theme.colors.surfacePressed : theme.colors.surfaceRaised, opacity: blocked ? 0.5 : 1 }]}>
            <AppIcon name="zap" size={18} color={theme.colors.textSecondary} />
            <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flexShrink: 1 }]}>{resolvedModelLabel}</Text>
            {modelStatus === "unknown" ? null : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: modelStatus === "available" ? theme.colors.success : modelStatus === "degraded" ? theme.colors.warning : theme.colors.danger }} />}
            <AppIcon name="chevron-down" size={14} color={theme.colors.textMuted} />
          </Pressable> : null}
          <View style={styles.composerToolbarSpacer} />
          {onVoice ? <Pressable accessibilityRole="button" accessibilityLabel={voiceActive ? t("ui.composer.voiceStop") : t("ui.composer.voiceStart")} accessibilityState={{ disabled: blocked || voiceStarting, selected: voiceActive }} disabled={blocked || voiceStarting} onPress={onVoice} style={({ pressed }) => [styles.composerCircleButton, { backgroundColor: voiceActive ? (pressed ? theme.colors.accentBorder : theme.colors.accentSoft) : pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised, opacity: blocked ? 0.45 : 1 }]}>{voiceStarting ? <ActivityIndicator size="small" color={theme.colors.textMuted} /> : <AppIcon name="mic" size={21} color={voiceActive ? theme.colors.accent : theme.colors.textSecondary} />}</Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={canStop ? t("ui.composer.stop") : t("ui.composer.send")} disabled={!canStop && !canSend} onPress={() => { if (canStop) onStop?.(); else onSend(); }} style={({ pressed }) => [styles.sendButton, { backgroundColor: canStop ? (pressed ? theme.colors.textSecondary : theme.colors.text) : canSend ? (pressed ? theme.colors.accentPressed : theme.colors.accent) : theme.colors.surfaceRaised }]}>
            <AppIcon name={canStop ? "stop" : "arrow-up"} size={canStop ? 17 : 22} color={canStop ? theme.colors.background : canSend ? theme.colors.accentText : theme.colors.textFaint} fill={canStop ? theme.colors.background : undefined} />
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
  const { t } = useTranslation();
  if (state === "open" || state === "idle") return null;
  const reconnecting = state === "reconnecting" || state === "connecting";
  return <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingVertical: 8, backgroundColor: reconnecting ? theme.colors.warningSoft : theme.colors.dangerSoft }}><AppIcon name={reconnecting ? "sync" : "cloud-off"} size={14} color={reconnecting ? theme.colors.warning : theme.colors.danger} /><Text style={[typography.caption, { color: reconnecting ? theme.colors.warning : theme.colors.danger }]}>{reconnecting ? t("ui.banner.reconnecting") : t("ui.banner.unavailable")}</Text></View>;
}

export function DataError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return <View style={[styles.dataError, { backgroundColor: theme.colors.dangerSoft, borderColor: theme.colors.danger }]}><View style={[styles.dataErrorIcon, { backgroundColor: theme.colors.background }]}><AppIcon name="cloud-off" size={17} color={theme.colors.danger} /></View><View style={{ flex: 1, minWidth: 0 }}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{t("ui.dataError.title")}</Text><Text selectable style={[typography.caption, { color: theme.colors.danger, marginTop: 3 }]}>{message}</Text></View><IconButton name="refresh" label={t("ui.dataError.retry")} onPress={onRetry} tone="danger" /></View>;
}

export function getStatusTone(status: ActivityItem["status"]): "success" | "warning" | "danger" | "neutral" {
  return status === "running" ? "warning" : status === "failed" ? "danger" : status === "stopped" ? "neutral" : "success";
}

export function useBackButton() {
  return useRouter();
}

const styles = StyleSheet.create({
  iconButton: { alignItems: "center", justifyContent: "center" },
  topBar: { minHeight: 56, flexShrink: 0, paddingHorizontal: 8, paddingVertical: 6, flexDirection: "row", alignItems: "center", gap: 4 },
  topBarLeading: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  topBarTitle: { flex: 1, minWidth: 0, justifyContent: "center", paddingHorizontal: 4 },
  topBarActions: { flexShrink: 0, flexDirection: "row", alignItems: "center" },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingTop: 22, paddingBottom: 10 },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, minHeight: 260 },
  dataError: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginTop: 12, padding: 12, borderWidth: 1, borderRadius: 14 },
  dataErrorIcon: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  primaryButton: { minHeight: 46, paddingHorizontal: 18, borderRadius: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  searchField: { minHeight: 48, borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  composerWrap: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10 },
  composer: { paddingHorizontal: 8, paddingVertical: 8, gap: 8, borderRadius: 18, borderCurve: "continuous", borderWidth: 1, overflow: "hidden" },
  composerInputRow: { flexDirection: "row", alignItems: "flex-start" },
  composerText: { flex: 1, minWidth: 0, paddingHorizontal: 5, paddingVertical: COMPOSER_TEXT_PADDING / 2, textAlignVertical: "top", includeFontPadding: false },
  composerExpandSlot: { width: 44, height: 44 },
  composerExpandButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  composerToolbar: { height: 44, flexDirection: "row", alignItems: "center", gap: 6 },
  composerToolbarSpacer: { flex: 1, minWidth: 0 },
  composerModel: { height: 44, maxWidth: "58%", flexShrink: 1, minWidth: 0, paddingHorizontal: 10, borderRadius: 22, flexDirection: "row", alignItems: "center", gap: 6, overflow: "hidden" },
  composerCircleButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  sendButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  attachmentChip: { flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 7, maxWidth: "100%" },
});
