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
        <DebugRow icon="zap" title="快速气泡渲染" detail="高速追加 / 循环各种 Markdown 气泡，实时 FPS" onPress={() => router.push("/debug/bubbles")} />
        <DebugRow icon="terminal" title="工具展开验收" detail="长输出、报错、编辑 diff 的展开高度" onPress={() => router.push("/debug/tools")} />
        <DebugRow icon="code" title="Markdown 渲染验收" detail="标题、表格、代码块、列表、引用" onPress={() => router.push("/debug/markdown")} />
        <DebugRow icon="list-tree" title="长列表性能" detail="500 / 2000 / 10000 条消息" onPress={() => router.push("/debug/list")} />
      </View>

      <SectionHeader title="运行时 / 数据" />
      <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <DebugRow icon="download" title="更新与 OTA" detail="expo-updates 状态、GitHub APK 检查、冷启动" onPress={() => router.push("/debug/updates")} />
        <DebugRow icon="messages" title="消息与 usage" detail="最近 assistant 消息的 usage 原始数据 + 真实气泡 footer" onPress={() => router.push("/debug/messages")} />
        <DebugRow icon="database" title="缓存检查器" detail="SQLite 行数、user_key、清空当前用户缓存" onPress={() => router.push("/debug/cache")} />
        <DebugRow icon="zap" title="输入框状态" detail="composer 全部组合 + 交互预览" onPress={() => router.push("/debug/composer")} />
        <DebugRow icon="activity" title="连接与流" detail="连接状态机、活跃流、同步状态与时间线" onPress={() => router.push("/debug/connection")} />
        <DebugRow icon="globe" title="深链测试" detail="解析并打开 cohub:// / web / 文件 / 外部链接" onPress={() => router.push("/debug/links")} />
        <DebugRow icon="type" title="语言 / i18n" detail="当前语言、key 检索、中英文对照" onPress={() => router.push("/debug/i18n")} />
        <DebugRow icon="fingerprint" title="身份与令牌" detail="claims、令牌存在性/过期（不显示明文）" onPress={() => router.push("/debug/identity")} />
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
