import { useRouter } from "expo-router";
import * as Updates from "expo-updates";
import { Platform, Pressable, Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import { getInstalledAppVersion } from "@/src/platform/app-updates";
import { useAppTheme, useFontScalePreference, typography } from "@/src/theme";
import { AppIcon, Screen, SectionHeader, type IconName } from "@/src/ui";

function updateInfo() {
  try {
    return {
      runtime: Updates.runtimeVersion ?? "—",
      update: Updates.isEmbeddedLaunch ? "embedded" : (Updates.updateId ?? "—").slice(0, 8),
    };
  } catch {
    return { runtime: "—", update: "—" };
  }
}

export default function DebugMenuScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { connectionState, installationId } = useApp();
  const fontScale = useFontScalePreference();
  const version = getInstalledAppVersion();
  const updates = updateInfo();

  return (
    <Screen scroll>

      <SectionHeader title="渲染验收" />
      <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <DebugRow icon="activity" title="流式渲染验收" detail="文本 + 工具调用实时流式，含重渲染计数" onPress={() => router.push("/debug/streaming")} />
        <DebugRow icon="terminal" title="工具展开验收" detail="长输出、报错、编辑 diff 的展开高度" onPress={() => router.push("/debug/tools")} />
        <DebugRow icon="code" title="Markdown 渲染验收" detail="标题、表格、代码块、列表、引用" onPress={() => router.push("/debug/markdown")} />
        <DebugRow icon="list-tree" title="长列表性能" detail="500 / 2000 / 10000 条消息" onPress={() => router.push("/debug/list")} />
      </View>

      <SectionHeader title="环境信息" />
      <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <DebugRow icon="info" title="版本" detail={`${version} · runtime ${updates.runtime} · update ${updates.update}`} />
        <DebugRow icon="monitor" title="平台" detail={`${Platform.OS} ${String(Platform.Version)}`} />
        <DebugRow icon="fingerprint" title="安装 ID" detail={installationId ?? "—"} />
        <DebugRow icon="wifi" title="连接状态" detail={connectionState} />
        <DebugRow icon="palette" title="外观" detail={`${theme.mode} · 字号 ${fontScale}`} />
      </View>

      <Text selectable style={[typography.micro, { color: theme.colors.textFaint, textAlign: "center", marginTop: 22, marginBottom: 8 }]}>
        在 Profile 或 About 连续点击版本号 5 次进入此页
      </Text>
    </Screen>
  );
}

function DebugRow({ icon, title, detail, onPress }: { icon: IconName; title: string; detail: string; onPress?: () => void }) {
  const theme = useAppTheme();
  const content = (
    <View style={[styles.row, { borderBottomColor: theme.colors.border }]}>
      <View style={[styles.rowIcon, { backgroundColor: theme.colors.surfaceRaised }]}>
        <AppIcon name={icon} size={16} color={theme.colors.textMuted} />
      </View>
      <View style={styles.rowText}>
        <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{title}</Text>
        <Text numberOfLines={2} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{detail}</Text>
      </View>
      {onPress ? <AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} /> : null}
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={({ pressed }) => ({ backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}>
      {content}
    </Pressable>
  ) : content;
}

const styles = {
  group: { marginHorizontal: 16, borderWidth: 1, borderRadius: 14, overflow: "hidden" as const },
  row: { minHeight: 62, flexDirection: "row" as const, alignItems: "center" as const, gap: 11, paddingHorizontal: 13, borderBottomWidth: 1 },
  rowIcon: { width: 32, height: 32, borderRadius: 10, alignItems: "center" as const, justifyContent: "center" as const },
  rowText: { flex: 1, minWidth: 0 },
} satisfies Record<string, object>;
