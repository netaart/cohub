import type { SandboxSpecId, SpaceSandboxAutoDestroyPolicy } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useApp } from "@/src/data/context";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, PrimaryButton, Screen, TopBar } from "@/src/ui";

export default function SpaceSettingsScreen() {
  const { spaceId } = useLocalSearchParams<{ spaceId: string }>();
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { client } = useApp();
  const [env, setEnv] = useState<{ name: string; value: string }[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [config, setConfig] = useState<{ provider?: string; spec?: string; autoDestroy?: { mode: string; ttlSeconds?: number } } | null>(null);
  const [ports, setPorts] = useState<Record<string, { url?: string; port?: number }>>({});
  const [busy, setBusy] = useState(false);
  const updateSandbox = async (next: { spec?: SandboxSpecId; autoDestroy?: SpaceSandboxAutoDestroyPolicy }) => { if (!client || !spaceId) return; setBusy(true); try { const result = await client.space(spaceId).updateConfig({ sandbox: next }); setConfig(result.space ? (await client.space(spaceId).getConfig()).config.sandbox : config); } finally { setBusy(false); } };
  useEffect(() => { if (!client || !spaceId) return; const space = client.space(spaceId); void Promise.all([space.env.list(), space.getConfig(), space.sandbox.ports()]).then(([environment, settings, endpointResult]) => { setEnv(environment.env); setConfig(settings.config.sandbox); setPorts(endpointResult.endpoints); }); }, [client, spaceId]);
  const addEnv = async () => { if (!client || !spaceId || !name.trim()) return; setBusy(true); try { const result = await client.space(spaceId).env.create({ name: name.trim(), value }); setEnv(result.env); setName(""); setValue(""); } finally { setBusy(false); } };
  return <Screen><TopBar title={t("space.settings")} onBack={() => router.back()} /><ScrollView contentContainerStyle={{ padding: 16, gap: 22 }}>
    <View><Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.environment")}</Text><View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}><TextInput value={name} onChangeText={setName} placeholder="NAME" autoCapitalize="characters" style={{ flex: 1, borderWidth: 1, borderColor: theme.colors.border, padding: 10, color: theme.colors.text }} /><TextInput value={value} onChangeText={setValue} placeholder="VALUE" style={{ flex: 1, borderWidth: 1, borderColor: theme.colors.border, padding: 10, color: theme.colors.text }} /></View><PrimaryButton label={t("space.settings.addEnvironment")} icon="plus" onPress={() => void addEnv()} disabled={busy} style={{ marginTop: 10 }} />{env.map((item) => <View key={item.name} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{item.name}</Text><Text selectable style={[typography.caption, { color: theme.colors.textMuted }]}>{item.value}</Text></View>)}</View>
    <View><Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.sandbox")}</Text><Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 8 }]}>{t("space.settings.spec")}</Text><View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>{(["standard", "boost", "ultra"] as const).map((spec) => <Pressable key={spec} disabled={busy} onPress={() => void updateSandbox({ spec })} style={{ flex: 1, padding: 12, borderWidth: 1, borderColor: config?.spec === spec ? theme.colors.accent : theme.colors.border, backgroundColor: config?.spec === spec ? theme.colors.accentSoft : theme.colors.surfaceRaised }}><Text style={[typography.bodyMedium, { color: theme.colors.text, textAlign: "center" }]}>{spec}</Text></Pressable>)}</View><Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 16 }]}>{t("space.settings.sleep")}</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>{([{ mode: "never" }, { mode: "idle", ttlSeconds: 1800 }, { mode: "idle", ttlSeconds: 7200 }] as const).map((policy) => { const selected = config?.autoDestroy?.mode === policy.mode && (policy.mode === "never" || config.autoDestroy?.ttlSeconds === policy.ttlSeconds); return <Pressable key={`${policy.mode}-${policy.mode === "idle" ? policy.ttlSeconds : 0}`} disabled={busy} onPress={() => void updateSandbox({ autoDestroy: policy })} style={{ padding: 12, borderWidth: 1, borderColor: selected ? theme.colors.accent : theme.colors.border, backgroundColor: selected ? theme.colors.accentSoft : theme.colors.surfaceRaised }}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{policy.mode === "never" ? t("space.settings.sleep.never") : `${(policy.ttlSeconds ?? 0) / 3600}h`}</Text></Pressable>; })}</View></View>
    <View><Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.ports")}</Text>{Object.entries(ports).map(([key, endpoint]) => <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10 }}><AppIcon name="globe" size={16} color={theme.colors.accent} /><Text selectable style={[typography.body, { color: theme.colors.text }]}>{key}: {endpoint.port ?? ""} {endpoint.url ?? ""}</Text></View>)}</View>
  </ScrollView></Screen>;
}
