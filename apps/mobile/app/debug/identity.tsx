import Constants from "expo-constants";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useProfileSession } from "@/src/auth/profile-session";
import { useApp } from "@/src/data/context";
import { typography, useAppTheme } from "@/src/theme";
import { AppIcon, PrimaryButton, Screen, SectionHeader } from "@/src/ui";
import type { IconName } from "@/src/icons";

type TokenInfo = { present: boolean; length: number };

function maskEmail(value: unknown) {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const [user, domain] = value.split("@");
  return `${user.slice(0, 1)}***@${domain}`;
}

function formatClaim(key: string, value: unknown) {
  if (key === "email") return maskEmail(value) ?? "—";
  if (key === "exp" && typeof value === "number") return new Date(value * 1000).toLocaleString();
  if (value == null) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export default function DebugIdentityScreen() {
  const theme = useAppTheme();
  const { userUuid, installationId, getAccessToken } = useApp();
  const { getClaims } = useProfileSession();
  const [claims, setClaims] = useState<Record<string, unknown> | null>(null);
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [expiresInSeconds, setExpiresInSeconds] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadClaims = useCallback(async () => {
    setBusy("claims");
    setError(null);
    try {
      const next = await getClaims();
      setClaims(next);
      setExpiresInSeconds(typeof next.exp === "number" ? Math.round(next.exp - Date.now() / 1000) : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取 claims 失败");
    } finally {
      setBusy(null);
    }
  }, [getClaims]);

  const loadToken = useCallback(async (forceRefresh: boolean) => {
    setBusy(forceRefresh ? "refresh" : "token");
    setError(null);
    try {
      const value = await getAccessToken(forceRefresh ? { forceRefresh: true } : undefined);
      setToken({ present: Boolean(value), length: value?.length ?? 0 });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取 token 失败");
    } finally {
      setBusy(null);
    }
  }, [getAccessToken]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadClaims();
      void loadToken(false);
    });
  }, [loadClaims, loadToken]);

  const claimEntries = claims ? Object.entries(claims).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <SectionHeader title="身份" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <Row icon="fingerprint" label="userUuid" value={userUuid} />
          <Row icon="user" label="display" value={typeof claims?.name === "string" ? claims.name : "—"} />
          <Row icon="globe" label="email" value={maskEmail(claims?.email) ?? "—"} />
          <Row icon="wifi" label="installation" value={installationId ?? "preparing…"} />
          <Row icon="monitor" label="environment" value={String(Constants.executionEnvironment)} />
        </View>

        <SectionHeader title="访问令牌" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <Row icon="shield" label="存在" value={token ? (token.present ? "yes" : "no") : "…"} />
          <Row icon="code" label="长度" value={token ? String(token.length) : "…"} />
          <Row icon="refresh" label="剩余有效期" value={expiresInSeconds != null ? `${expiresInSeconds}s` : "—"} />
        </View>
        <Text style={[typography.micro, { color: theme.colors.textFaint, marginHorizontal: 16, marginTop: 8 }]}>
          只显示令牌是否存在与长度，绝不显示明文；claims 中的邮箱也做了掩码。
        </Text>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
          <PrimaryButton label="读取 claims" icon="user" loading={busy === "claims"} disabled={busy !== null} onPress={() => void loadClaims()} />
          <PrimaryButton label="读取 token" icon="shield" loading={busy === "token"} disabled={busy !== null} onPress={() => void loadToken(false)} />
          <PrimaryButton label="强制刷新 token" icon="refresh" tone="danger" loading={busy === "refresh"} disabled={busy !== null} onPress={() => void loadToken(true)} />
        </View>
        {error ? <Text selectable style={[typography.caption, { color: theme.colors.danger, marginHorizontal: 16, marginTop: 12 }]}>{error}</Text> : null}

        <SectionHeader title={`ID Token claims · ${claimEntries.length}`} />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          {claimEntries.length === 0 ? (
            <Text style={[typography.caption, { color: theme.colors.textMuted, padding: 14 }]}>暂无 claims</Text>
          ) : claimEntries.map(([key, value]) => (
            <View key={key} style={{ paddingHorizontal: 13, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: theme.colors.border, gap: 3 }}>
              <Text style={[typography.micro, { color: theme.colors.accent, fontFamily: "SpaceMono" }]}>{key}</Text>
              <Text selectable style={[typography.caption, { color: theme.colors.textSecondary }]}>{formatClaim(key, value)}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

function Row({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const theme = useAppTheme();
  return (
    <View style={{ minHeight: 52, paddingHorizontal: 13, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <View style={{ width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised }}>
        <AppIcon name={icon} size={15} color={theme.colors.textMuted} />
      </View>
      <Text style={[typography.caption, { color: theme.colors.textMuted, width: 110 }]}>{label}</Text>
      <Text selectable numberOfLines={2} style={[typography.caption, { color: theme.colors.text, flex: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

const styles = {
  group: { marginHorizontal: 16, borderWidth: 1, borderRadius: 14, overflow: "hidden" as const },
} satisfies Record<string, object>;
