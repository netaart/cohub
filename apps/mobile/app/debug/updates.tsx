import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import {
  checkForAppUpdate,
  getInstalledAppVersion,
  isUpdateSnoozed,
  type AppRelease,
} from "@/src/platform/app-updates";
import { typography, useAppTheme } from "@/src/theme";
import { AppIcon, PrimaryButton, Screen, SectionHeader } from "@/src/ui";
import type { IconName } from "@/src/icons";

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function formatBytes(value: number | null) {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function short(value: string | null | undefined, size = 12) {
  if (!value) return "—";
  return value.length > size ? `${value.slice(0, size)}…` : value;
}

export default function DebugUpdatesScreen() {
  const theme = useAppTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [releaseChecked, setReleaseChecked] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [snoozed, setSnoozed] = useState<boolean | null>(null);
  const [ota, setOta] = useState<string | null>(null);
  const [otaError, setOtaError] = useState<string | null>(null);

  const executionEnvironment = safe(
    () => String(Constants.executionEnvironment),
    "unknown",
  );
  const updatesEnabled = safe(() => Updates.isEnabled, false);

  const busyRef = useRef(false);
  const withBusy = useCallback(async (key: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    try {
      await action();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, []);

  const checkRelease = useCallback(
    () =>
      withBusy("release", async () => {
        setReleaseError(null);
        try {
          const latest = await checkForAppUpdate({ force: true });
          setRelease(latest);
          setReleaseChecked(true);
          setSnoozed(latest ? await isUpdateSnoozed(latest.version) : null);
        } catch (error) {
          setReleaseError(error instanceof Error ? error.message : "检查更新失败");
        }
      }),
    [withBusy],
  );

  useEffect(() => {
    void Promise.resolve().then(() => checkRelease());
  }, [checkRelease]);

  const checkOta = useCallback(
    () =>
      withBusy("ota", async () => {
        setOtaError(null);
        setOta(null);
        try {
          const result = (await Updates.checkForUpdateAsync()) as {
            isAvailable?: boolean;
            manifest?: { id?: string } | null;
            isRollBackToEmbedded?: boolean;
          };
          setOta(
            [
              `isAvailable: ${String(result.isAvailable ?? false)}`,
              `rollback: ${String(result.isRollBackToEmbedded ?? false)}`,
              `manifest: ${result.manifest?.id ?? "—"}`,
            ].join("\n"),
          );
        } catch (error) {
          setOtaError(error instanceof Error ? error.message : "OTA 检查失败");
        }
      }),
    [withBusy],
  );

  const fetchAndReload = useCallback(
    () =>
      withBusy("fetch", async () => {
        setOtaError(null);
        try {
          const result = (await Updates.fetchUpdateAsync()) as {
            isNew?: boolean;
            manifest?: { id?: string } | null;
          };
          setOta(
            [`isNew: ${String(result.isNew ?? false)}`, `manifest: ${result.manifest?.id ?? "—"}`, "即将重启加载新包…"].join("\n"),
          );
          if (result.isNew) await Updates.reloadAsync();
        } catch (error) {
          setOtaError(error instanceof Error ? error.message : "下载并重启失败");
        }
      }),
    [withBusy],
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <SectionHeader title="已安装原生包" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <Row icon="info" label="应用版本" value={getInstalledAppVersion()} />
          <Row icon="fingerprint" label="Build" value={String(safe(() => Application.nativeBuildVersion, null) ?? "—")} />
          <Row icon="database" label="包名" value={safe(() => Application.applicationId, null) ?? "—"} />
          <Row icon="monitor" label="运行环境" value={String(executionEnvironment)} />
        </View>

        <SectionHeader title="expo-updates" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <Row
            icon={updatesEnabled ? "check-circle" : "cloud-off"}
            label="OTA 是否启用"
            value={updatesEnabled ? "enabled" : "disabled"}
            tone={updatesEnabled ? "success" : "muted"}
          />
          <Row icon="zap" label="runtimeVersion" value={safe(() => Updates.runtimeVersion, null) ?? "—"} />
          <Row icon="wifi" label="channel" value={safe(() => Updates.channel, null) ?? "—"} />
          <Row icon="layers" label="updateId" value={safe(() => Updates.updateId, null) ?? "—"} />
          <Row icon="download" label="嵌入启动" value={String(safe(() => Updates.isEmbeddedLaunch, false))} />
          <Row
            icon="alert"
            label="应急启动"
            value={
              safe(() => Updates.isEmergencyLaunch, false)
                ? `yes · ${safe(() => Updates.emergencyLaunchReason, null) ?? "—"}`
                : "no"
            }
          />
          <Row icon="refresh" label="checkAutomatically" value={safe(() => Updates.checkAutomatically, null) ?? "—"} />
        </View>
        {!updatesEnabled ? (
          <Text style={[typography.caption, { color: theme.colors.textMuted, marginHorizontal: 16, marginTop: 10 }]}>
            Expo Go / 开发构建里 OTA 恒为 disabled，只有带 EXPO_PUBLIC_UPDATES_URL 的正式构建才会启用。
          </Text>
        ) : null}

        <SectionHeader title="expo-updates 操作" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <View style={{ padding: 14, gap: 10 }}>
            <PrimaryButton
              label="检查 OTA 更新"
              icon="refresh"
              loading={busy === "ota"}
              disabled={!updatesEnabled || busy !== null}
              onPress={() => void checkOta()}
            />
            <PrimaryButton
              label="下载并重启"
              icon="download"
              tone="danger"
              loading={busy === "fetch"}
              disabled={!updatesEnabled || busy !== null}
              onPress={() => void fetchAndReload()}
            />
            {ota ? <Text selectable style={[typography.code, { color: theme.colors.textSecondary }]}>{ota}</Text> : null}
            {otaError ? <Text selectable style={[typography.caption, { color: theme.colors.danger }]}>{otaError}</Text> : null}
          </View>
        </View>

        <SectionHeader title="GitHub 原生发布 (APK)" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          {busy === "release" && !releaseChecked ? (
            <View style={{ padding: 20, alignItems: "center" }}>
              <ActivityIndicator size="small" color={theme.colors.accent} />
            </View>
          ) : release ? (
            <>
              <Row icon="download" label="可更新版本" value={release.version} tone="accent" />
              <Row icon="info" label="标题" value={release.title ?? "—"} />
              <Row icon="layers" label="APK 资源" value={release.downloadName ?? "—"} />
              <Row icon="database" label="APK 大小" value={formatBytes(release.downloadSize)} />
              <Row icon="fingerprint" label="sha256" value={short(release.downloadSha256, 16)} />
              <Row icon="alert" label="已忽略(snooze)" value={snoozed == null ? "—" : snoozed ? "yes" : "no"} />
            </>
          ) : (
            <Row icon="check-circle" label="状态" value={releaseError ? "检查失败" : "已是最新原生版本"} tone={releaseError ? "danger" : "success"} />
          )}
          {releaseError ? <Row icon="alert" label="错误" value={releaseError} tone="danger" /> : null}
          <View style={{ padding: 14 }}>
            <PrimaryButton
              label="重新检查 GitHub 发布"
              icon="refresh"
              loading={busy === "release"}
              disabled={busy !== null}
              onPress={() => void checkRelease()}
            />
          </View>
        </View>

        <Text style={[typography.micro, { color: theme.colors.textFaint, marginHorizontal: 16, marginTop: 16 }]}>
          说明：OTA 只在“下次冷启动”生效；APK 更新只在存在更新版本的签名 APK 时才提示，纯 JS 更新不会触发 APK 下载。
        </Text>
      </ScrollView>
    </Screen>
  );
}

function Row({ icon, label, value, tone = "default" }: { icon: IconName; label: string; value: string; tone?: "default" | "success" | "danger" | "accent" | "muted" }) {
  const theme = useAppTheme();
  const color = tone === "success" ? theme.colors.success : tone === "danger" ? theme.colors.danger : tone === "accent" ? theme.colors.accent : tone === "muted" ? theme.colors.textMuted : theme.colors.text;
  const iconColor = tone === "danger" ? theme.colors.danger : tone === "success" ? theme.colors.success : theme.colors.textMuted;
  return (
    <View style={{ minHeight: 60, paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised }}>
        <AppIcon name={icon} size={16} color={iconColor} />
      </View>
      <Text style={[typography.caption, { color: theme.colors.textMuted, width: 118 }]}>{label}</Text>
      <Text selectable numberOfLines={3} style={[typography.caption, { color, flex: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

const styles = {
  group: { marginHorizontal: 16, borderWidth: 1, borderRadius: 14, overflow: "hidden" as const },
} satisfies Record<string, object>;
