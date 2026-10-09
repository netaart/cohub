import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { RefObject } from "react";
import type { RuntimeHarness, SpaceRuntimeStatus } from "@/src/data/runtime";
import { ComposerMenu } from "@/src/components/ComposerMenu";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { AppIcon, IconButton } from "@/src/ui";

const HARNESSES: RuntimeHarness[] = ["cohub", "pi", "codex"];

export function HarnessPicker({
  anchorRef,
  value,
  status,
  open,
  onClose,
  onRefresh,
  onSelect,
}: {
  anchorRef: RefObject<View | null>;
  value: RuntimeHarness;
  status: SpaceRuntimeStatus | null;
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (harness: RuntimeHarness) => void;
}) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const localSpace = status?.kind === "local";
  const available = useMemo(() => new Set(status?.capabilities?.harnesses ?? []), [status]);

  return open ? <ComposerMenu anchorRef={anchorRef} title={t("runtime.harness.title")} onClose={onClose} preferredWidth={300} testID="chat-harness-selector-menu">
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 }}>
        <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{t("runtime.harness.title")}</Text>
        {localSpace ? <Text style={[typography.micro, { color: theme.colors.textFaint, marginTop: 4 }]}>{status?.online ? t("runtime.connected") : t("runtime.offline")}</Text> : null}
      </View>
      <ScrollView contentContainerStyle={{ padding: 6 }}>
        {HARNESSES.map((harness) => {
          const enabled = harness === "cohub" || (localSpace && status?.online === true && available.has(harness));
          const selected = value === harness;
          return <Pressable
            key={harness}
            testID={`chat-harness-option-${harness}`}
            accessibilityRole="radio"
            accessibilityLabel={t(`runtime.harness.${harness}`)}
            accessibilityState={{ checked: selected, disabled: !enabled }}
            disabled={!enabled}
            onPress={() => { onSelect(harness); onClose(); }}
            style={({ pressed }) => ({ minHeight: 52, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: pressed || selected ? theme.colors.surfaceRaised : "transparent", opacity: enabled ? 1 : 0.48 })}
          >
            <AppIcon name={harness === "cohub" ? "cloud" : "monitor"} size={18} color={theme.colors.textMuted} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{t(`runtime.harness.${harness}`)}</Text>
              <Text numberOfLines={1} style={[typography.micro, { color: theme.colors.textMuted }]}>{harness === "cohub" ? t("runtime.cloudExecution") : enabled ? t("runtime.localExecution") : localSpace && !status?.online ? t("runtime.offline") : t("runtime.notConnected")}</Text>
            </View>
            {selected ? <AppIcon name="check" size={18} color={theme.colors.accent} /> : null}
          </Pressable>;
        })}
        {!localSpace ? <Text style={[typography.micro, { paddingHorizontal: 10, paddingTop: 6, paddingBottom: 8, color: theme.colors.textFaint }]}>{t("runtime.localOnly")}</Text> : null}
        {localSpace && !status?.online ? <View style={{ paddingHorizontal: 8, paddingTop: 4 }}><IconButton name="refresh" label={t("common.retry")} onPress={onRefresh} /></View> : null}
      </ScrollView>
    </ComposerMenu> : null;
}
