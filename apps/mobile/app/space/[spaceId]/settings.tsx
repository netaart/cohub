import * as Clipboard from "expo-clipboard";
import type { SandboxSpecId, SpaceSandboxAutoDestroyPolicy } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Image, Linking, Pressable, ScrollView, Share, Text, TextInput, View } from "react-native";
import { useToast } from "@/src/components/Toast";
import { useApp } from "@/src/data/context";
import { useTranslation } from "@/src/i18n";
import { openWebLink } from "@/src/platform/browser";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, PrimaryButton, Screen, TopBar } from "@/src/ui";

type EnvItem = { name: string; value: string };
type SandboxConfig = { provider?: string; spec?: SandboxSpecId; autoDestroy?: SpaceSandboxAutoDestroyPolicy };

export default function SpaceSettingsScreen() {
  const { spaceId } = useLocalSearchParams<{ spaceId: string }>();
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const toast = useToast();
  const { client } = useApp();
  const [env, setEnv] = useState<EnvItem[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [config, setConfig] = useState<SandboxConfig | null>(null);
  const [ports, setPorts] = useState<Record<string, { url?: string; port?: number }>>({});
  const [busy, setBusy] = useState(false);
  const [visibleEnv, setVisibleEnv] = useState<Set<string>>(new Set());
  const [allowedSpec, setAllowedSpec] = useState<SandboxSpecId>("standard");
  const [members, setMembers] = useState<{ userId: string; role: "host" | "builder" | "guest"; profile: { name?: string | null; username?: string | null; avatarUrl?: string | null } }[]>([]);
  const [invitations, setInvitations] = useState<{ token: string; role: "host" | "builder" | "guest"; status: string }[]>([]);

  useEffect(() => {
    if (!client || !spaceId) return;
    const space = client.space(spaceId);
    void Promise.all([
      space.env.list(),
      space.getConfig(),
      space.sandbox.ports(),
      client.billing.getFeatureEntitlement("sandbox.spec.boost"),
      client.billing.getFeatureEntitlement("sandbox.spec.ultra"),
      space.members.list(),
      space.invitations.list(),
    ]).then(([environment, settings, endpointResult, boost, ultra, memberResult, invitationResult]) => {
      setEnv(environment.env);
      setConfig(settings.config.sandbox);
      setPorts(endpointResult.endpoints);
      setAllowedSpec(ultra.enabled ? "ultra" : boost.enabled ? "boost" : "standard");
      setMembers(memberResult.items);
      setInvitations(invitationResult.items);
    });
  }, [client, spaceId]);

  const addEnv = async () => {
    if (!client || !spaceId || !name.trim()) return;
    setBusy(true);
    try {
      const result = await client.space(spaceId).env.create({ name: name.trim(), value });
      setEnv(result.env);
      setName("");
      setValue("");
      toast({ title: t("space.settings.saved") });
    } finally {
      setBusy(false);
    }
  };

  const createInvite = async (role: "builder" | "guest") => {
    if (!client || !spaceId) return;
    try {
      const result = await client.space(spaceId).invitations.create({ role, ttlSeconds: 604800 });
      await Share.share({ title: t("space.settings.inviteTitle"), message: `https://cohub.live/invite/${result.token}` });
      setInvitations((current) => [...current, { token: result.token, role: result.role, status: "active" }]);
    } catch (error) { toast({ title: t("space.settings.inviteFailed"), message: error instanceof Error ? error.message : undefined, tone: "danger" }); }
  };
  const updateMemberRole = async (userId: string, role: "builder" | "guest") => {
    if (!client || !spaceId) return;
    try { const updated = await client.space(spaceId).members.update(userId, role); setMembers((current) => current.map((member) => member.userId === userId ? { ...member, role: updated.role } : member)); } catch (error) { toast({ title: t("space.settings.memberUpdateFailed"), message: error instanceof Error ? error.message : undefined, tone: "danger" }); }
  };
  const removeMember = async (userId: string) => {
    if (!client || !spaceId) return;
    try { await client.space(spaceId).members.remove(userId); setMembers((current) => current.filter((member) => member.userId !== userId)); } catch (error) { toast({ title: t("space.settings.memberRemoveFailed"), message: error instanceof Error ? error.message : undefined, tone: "danger" }); }
  };
  const updateSandbox = async (next: { spec?: SandboxSpecId; autoDestroy?: SpaceSandboxAutoDestroyPolicy }) => {
    if (!client || !spaceId) return;
    setBusy(true);
    try {
      await client.space(spaceId).updateConfig({ sandbox: next });
      setConfig((current) => current ? { ...current, ...next } : current);
      toast({ title: t("space.settings.saved") });
    } finally {
      setBusy(false);
    }
  };

  return <Screen>
    <TopBar title={t("space.settings")} onBack={() => router.back()} />
    <ScrollView contentContainerStyle={{ padding: 16, gap: 26 }}>
      <View>
        <Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.collaborators")}</Text>
        {members.map((member) => <View key={member.userId} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>{member.profile.avatarUrl ? <Image source={{ uri: member.profile.avatarUrl }} style={{ width: 34, height: 34, borderRadius: 10 }} /> : <AppIcon name="user" size={18} color={theme.colors.accent} />}<View style={{ flex: 1 }}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{member.profile.name || member.profile.username || member.userId}</Text><Text style={[typography.micro, { color: theme.colors.textMuted }]}>{member.role}</Text></View>{member.role !== "host" ? <><Pressable onPress={() => void updateMemberRole(member.userId, member.role === "builder" ? "guest" : "builder")}><Text style={[typography.micro, { color: theme.colors.accent }]}>{member.role === "builder" ? t("space.settings.makeGuest") : t("space.settings.makeBuilder")}</Text></Pressable><Pressable onPress={() => void removeMember(member.userId)}><AppIcon name="x" size={17} color={theme.colors.danger} /></Pressable></> : null}</View>)}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}><PrimaryButton label={t("space.settings.inviteBuilder")} icon="plus" onPress={() => void createInvite("builder")} style={{ flex: 1 }} /><PrimaryButton label={t("space.settings.inviteGuest")} icon="plus" onPress={() => void createInvite("guest")} style={{ flex: 1 }} /></View>
        {invitations.filter((item) => item.status === "active").map((item) => <Text key={item.token} style={[typography.micro, { color: theme.colors.textMuted, marginTop: 8 }]}>{t("space.settings.inviteActive", { role: item.role })}</Text>)}
      </View>
      <View>
        <Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.environment")}</Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <TextInput value={name} onChangeText={setName} placeholder="NAME" placeholderTextColor={theme.colors.textFaint} autoCapitalize="characters" style={{ flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 12, color: theme.colors.text }} />
          <TextInput value={value} onChangeText={setValue} placeholder="VALUE" placeholderTextColor={theme.colors.textFaint} style={{ flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 12, color: theme.colors.text }} />
        </View>
        <PrimaryButton label={t("space.settings.addEnvironment")} icon="plus" onPress={() => void addEnv()} disabled={busy} style={{ marginTop: 10 }} />
        {env.map((item) => <EnvironmentRow key={item.name} item={item} visible={visibleEnv.has(item.name)} onToggle={() => setVisibleEnv((current) => { const next = new Set(current); if (next.has(item.name)) next.delete(item.name); else next.add(item.name); return next; })} onCopy={() => void Clipboard.setStringAsync(item.value).then(() => toast({ title: t("space.settings.copied") }))} />)}
      </View>

      <View>
        <Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.sandbox")}</Text>
        <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 10 }]}>{t("space.settings.spec")}</Text>
        <Slider values={["standard", "boost", "ultra"]} value={config?.spec ?? "standard"} maxValue={allowedSpec} disabled={busy} labels={[t("space.settings.spec.standard"), t("space.settings.spec.boost"), t("space.settings.spec.ultra")]} onChange={(spec) => void updateSandbox({ spec: spec as SandboxSpecId })} onLocked={() => toast({ title: t("space.settings.upgradeRequired"), message: t("space.settings.upgradeRequired.body"), tone: "danger" })} />
        <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 20 }]}>{t("space.settings.sleep")}</Text>
        <Slider values={["never", "0.5h", "2h"]} value={config?.autoDestroy?.mode === "never" ? "never" : config?.autoDestroy?.ttlSeconds === 1800 ? "0.5h" : "2h"} labels={[t("space.settings.sleep.never"), "0.5h", "2h"]} disabled={busy} onChange={(selected) => void updateSandbox({ autoDestroy: selected === "never" ? { mode: "never" } : { mode: "idle", ttlSeconds: selected === "0.5h" ? 1800 : 7200 } })} />
      </View>

      <View>
        <Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.ports")}</Text>
        {Object.entries(ports).map(([key, endpoint]) => <Pressable key={key} accessibilityRole="button" onPress={() => endpoint.url ? void openWebLink(endpoint.url).catch(() => Linking.openURL(endpoint.url!)) : undefined} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, padding: 14, marginTop: 8, borderRadius: 10, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised })}><AppIcon name="globe" size={18} color={theme.colors.accent} /><View style={{ flex: 1 }}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{t("space.settings.portLabel", { port: key })}</Text><Text numberOfLines={1} selectable style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3 }]}>{endpoint.url ?? t("space.settings.portUnavailable")}</Text></View><AppIcon name="external-link" size={16} color={theme.colors.textMuted} /></Pressable>)}
      </View>
    </ScrollView>
  </Screen>;
}

function EnvironmentRow({ item, visible, onToggle, onCopy }: { item: EnvItem; visible: boolean; onToggle: () => void; onCopy: () => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return <View style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border, gap: 6 }}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{item.name}</Text><View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Pressable accessibilityRole="button" accessibilityLabel={t("space.settings.copyValue")} onPress={onCopy} style={{ flex: 1 }}><Text selectable={visible} numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted }]}>{visible ? item.value : "•".repeat(Math.min(24, Math.max(8, item.value.length)))}</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={visible ? t("space.settings.hideValue") : t("space.settings.showValue")} onPress={onToggle} hitSlop={8}><AppIcon name={visible ? "eye-off" : "eye"} size={17} color={theme.colors.textMuted} /></Pressable></View></View>;
}

function Slider({ values, value, labels, maxValue, disabled, onChange, onLocked }: { values: readonly string[]; value: string; labels: readonly string[]; maxValue?: string; disabled?: boolean; onChange: (value: string) => void; onLocked?: () => void }) {
  const theme = useAppTheme();
  const selected = Math.max(0, values.indexOf(value));
  const max = maxValue ? Math.max(0, values.indexOf(maxValue)) : values.length - 1;
  return <View style={{ marginTop: 10, gap: 8 }}><View style={{ height: 36, justifyContent: "center" }}><View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.border }} /><View style={{ position: "absolute", left: 0, right: 0, flexDirection: "row", justifyContent: "space-between" }}>{values.map((item, index) => <Pressable key={item} accessibilityRole="button" accessibilityLabel={labels[index]} disabled={disabled} onPress={() => index <= max ? onChange(item) : onLocked?.()} style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" }}><View style={{ width: index === selected ? 18 : 12, height: index === selected ? 18 : 12, borderRadius: 10, backgroundColor: index > max ? theme.colors.border : index === selected ? theme.colors.accent : theme.colors.textMuted, borderWidth: index === selected ? 3 : 0, borderColor: theme.colors.background }} /></Pressable>)}</View></View><View style={{ flexDirection: "row" }}>{labels.map((label, index) => <Text key={label} style={[typography.micro, { color: index > max ? theme.colors.textFaint : index === selected ? theme.colors.accent : theme.colors.textMuted, textAlign: "center", flex: 1 }]}>{label}</Text>)}</View></View>;
}
