import * as Clipboard from "expo-clipboard";
import type { SandboxSpecId, SpaceMember, SpaceRole, SpaceSandboxAutoDestroyPolicy, SpaceSandboxConfig } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { useToast } from "@/src/components/Toast";
import { useApp } from "@/src/data/context";
import { useTranslation, type Translate } from "@/src/i18n";
import { openWebLink } from "@/src/platform/browser";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, Avatar, IconButton, Screen, TopBar, type IconName } from "@/src/ui";

type EnvItem = { name: string; value: string };
type InvitationItem = { token: string; role: SpaceRole; status: string };

const SPEC_OPTIONS = ["standard", "boost", "ultra"] as const;
const SLEEP_OPTIONS = ["never", "0.5h", "2h"] as const;

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
  const [config, setConfig] = useState<SpaceSandboxConfig | null>(null);
  const [ports, setPorts] = useState<Record<string, { url?: string; port?: number }>>({});
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [visibleEnv, setVisibleEnv] = useState<Set<string>>(new Set());
  const [allowedSpec, setAllowedSpec] = useState<SandboxSpecId>("standard");
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [invitations, setInvitations] = useState<InvitationItem[]>([]);

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
    } catch (error) {
      toast({ title: t("space.settings.inviteFailed"), message: error instanceof Error ? error.message : undefined, tone: "danger" });
    }
  };

  const updateMemberRole = async (userId: string, role: "builder" | "guest") => {
    if (!client || !spaceId) return;
    try {
      const updated = await client.space(spaceId).members.update(userId, role);
      setMembers((current) => current.map((member) => member.userId === userId ? { ...member, role: updated.role } : member));
    } catch (error) {
      toast({ title: t("space.settings.memberUpdateFailed"), message: error instanceof Error ? error.message : undefined, tone: "danger" });
    }
  };

  const removeMember = async (userId: string) => {
    if (!client || !spaceId) return;
    try {
      await client.space(spaceId).members.remove(userId);
      setMembers((current) => current.filter((member) => member.userId !== userId));
    } catch (error) {
      toast({ title: t("space.settings.memberRemoveFailed"), message: error instanceof Error ? error.message : undefined, tone: "danger" });
    }
  };

  const updateSandbox = async (next: { spec?: SandboxSpecId; autoDestroy?: SpaceSandboxAutoDestroyPolicy }) => {
    if (!client || !spaceId) return;
    setBusy(true);
    try {
      const space = client.space(spaceId);
      const result = await space.updateConfig({ sandbox: next });
      const refreshed = await space.getConfig().catch(() => null);
      const sandbox = refreshed?.config.sandbox;
      const pendingRestart = next.spec ? result.sandbox?.pendingRestart === true : false;
      if (sandbox) {
        setConfig({
          ...sandbox,
          specPendingRestart: pendingRestart || sandbox.specPendingRestart,
        });
      } else {
        setConfig((current) => current ? {
          ...current,
          ...next,
          specPendingRestart: pendingRestart || current.specPendingRestart,
        } : current);
      }
      if (next.spec) {
        toast({ title: specNeedsRestart(sandbox ?? null, pendingRestart) ? t("space.settings.spec.savedRestart") : t("space.settings.spec.updated") });
      } else {
        toast({ title: t("space.settings.saved") });
      }
    } finally {
      setBusy(false);
    }
  };

  const restartSandbox = async () => {
    if (!client || !spaceId) return;
    setRestarting(true);
    try {
      await client.space(spaceId).sandbox.recreate();
      const refreshed = await client.space(spaceId).getConfig().catch(() => null);
      if (refreshed?.config.sandbox) setConfig(refreshed.config.sandbox);
      else setConfig((current) => current ? { ...current, specPendingRestart: false, appliedSpec: current.spec ?? "standard" } : current);
      toast({ title: t("space.settings.sandbox.restarted") });
    } catch (error) {
      toast({ title: t("space.settings.sandbox.restartFailed"), message: error instanceof Error ? error.message : undefined, tone: "danger" });
    } finally {
      setRestarting(false);
    }
  };

  const confirmRestart = () => {
    Alert.alert(
      t("space.settings.sandbox.restartConfirm.title"),
      t("space.settings.sandbox.restartConfirm.body"),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("space.settings.spec.restartNow"), style: "destructive", onPress: () => void restartSandbox() },
      ],
    );
  };

  const inputStyle = [
    typography.body,
    styles.field,
    { borderColor: theme.colors.border, color: theme.colors.text, backgroundColor: theme.colors.surface },
  ];

  return (
    <Screen>
      <TopBar title={t("space.settings")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View>
          <Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.collaborators")}</Text>
          {members.map((member) => {
            const displayName = memberDisplayName(member, t("settings.profile.fallbackName"));
            return (
              <View key={member.userId} style={[styles.memberRow, { borderBottomColor: theme.colors.border }]}>
                <Avatar name={displayName} uri={member.profile?.avatarUrl} size={36} />
                <View style={styles.memberCopy}>
                  <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{displayName}</Text>
                  <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{roleLabel(member.role, t)}</Text>
                </View>
                {member.role !== "host" ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void updateMemberRole(member.userId, member.role === "builder" ? "guest" : "builder")}
                      hitSlop={8}
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                    >
                      <Text style={[typography.caption, { color: theme.colors.accent }]}>
                        {member.role === "builder" ? t("space.settings.makeGuest") : t("space.settings.makeBuilder")}
                      </Text>
                    </Pressable>
                    <IconButton name="x" label={t("space.settings.removeMember")} tone="danger" onPress={() => void removeMember(member.userId)} />
                  </>
                ) : null}
              </View>
            );
          })}
          <View style={styles.inviteRow}>
            <ActionButton label={t("space.settings.inviteBuilder")} icon="plus" onPress={() => void createInvite("builder")} />
            <ActionButton label={t("space.settings.inviteGuest")} icon="plus" onPress={() => void createInvite("guest")} />
          </View>
          {invitations.filter((item) => item.status === "active").map((item) => (
            <Text key={item.token} style={[typography.micro, { color: theme.colors.textMuted, marginTop: 8 }]}>
              {t("space.settings.inviteActive", { role: roleLabel(item.role, t) })}
            </Text>
          ))}
        </View>

        <View>
          <Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.environment")}</Text>
          <View style={styles.envRow}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="NAME"
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="characters"
              autoCorrect={false}
              accessibilityLabel="NAME"
              style={inputStyle}
            />
            <TextInput
              value={value}
              onChangeText={setValue}
              placeholder="VALUE"
              placeholderTextColor={theme.colors.textFaint}
              autoCorrect={false}
              accessibilityLabel="VALUE"
              style={inputStyle}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("space.settings.addEnvironment")}
              disabled={busy || !name.trim()}
              onPress={() => void addEnv()}
              style={({ pressed }) => [
                styles.envAdd,
                {
                  backgroundColor: pressed ? theme.colors.accentPressed : theme.colors.accent,
                  opacity: busy || !name.trim() ? 0.45 : 1,
                },
              ]}
            >
              <AppIcon name="plus" size={18} color={theme.colors.accentText} />
            </Pressable>
          </View>
          {env.map((item) => (
            <EnvironmentRow
              key={item.name}
              item={item}
              visible={visibleEnv.has(item.name)}
              onToggle={() => setVisibleEnv((current) => {
                const next = new Set(current);
                if (next.has(item.name)) next.delete(item.name);
                else next.add(item.name);
                return next;
              })}
              onCopy={() => void Clipboard.setStringAsync(item.value).then(() => toast({ title: t("space.settings.copied") }))}
            />
          ))}
        </View>

        <View>
          <Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.sandbox")}</Text>
          <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 10 }]}>{t("space.settings.spec")}</Text>
          <SegmentedControl
            values={SPEC_OPTIONS}
            value={config?.spec ?? "standard"}
            maxValue={allowedSpec}
            disabled={busy || restarting}
            labels={[t("space.settings.spec.standard"), t("space.settings.spec.boost"), t("space.settings.spec.ultra")]}
            onChange={(spec) => void updateSandbox({ spec })}
            onLocked={() => toast({ title: t("space.settings.upgradeRequired"), message: t("space.settings.upgradeRequired.body"), tone: "danger" })}
          />
          {specNeedsRestart(config) ? (
            <View style={styles.restartRow}>
              <View style={[styles.restartBadge, { backgroundColor: theme.colors.warningSoft }]}>
                <Text style={[typography.micro, { color: theme.colors.warning }]}>{t("space.settings.spec.restartToApply")}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("space.settings.spec.restartNow")}
                disabled={restarting || busy}
                onPress={confirmRestart}
                style={({ pressed }) => [styles.restartButton, { opacity: restarting || busy ? 0.45 : pressed ? 0.7 : 1 }]}
              >
                {restarting ? <ActivityIndicator color={theme.colors.accent} size="small" /> : <AppIcon name="refresh" size={14} color={theme.colors.accent} />}
                <Text style={[typography.caption, { color: theme.colors.accent }]}>{t("space.settings.spec.restartNow")}</Text>
              </Pressable>
            </View>
          ) : null}
          <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 20 }]}>{t("space.settings.sleep")}</Text>
          <SegmentedControl
            values={SLEEP_OPTIONS}
            value={sleepFromConfig(config)}
            labels={[t("space.settings.sleep.never"), t("space.settings.sleep.halfHour"), t("space.settings.sleep.twoHours")]}
            disabled={busy || restarting}
            onChange={(selected) => void updateSandbox({ autoDestroy: sleepToPolicy(selected) })}
          />
        </View>

        <View>
          <Text style={[typography.heading, { color: theme.colors.text }]}>{t("space.settings.ports")}</Text>
          {Object.entries(ports).map(([key, endpoint]) => (
            <Pressable
              key={key}
              accessibilityRole="button"
              onPress={() => endpoint.url ? void openWebLink(endpoint.url).catch(() => Linking.openURL(endpoint.url!)) : undefined}
              style={({ pressed }) => [styles.portRow, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised }]}
            >
              <AppIcon name="globe" size={18} color={theme.colors.accent} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{t("space.settings.portLabel", { port: key })}</Text>
                <Text numberOfLines={1} selectable style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3 }]}>
                  {endpoint.url ?? t("space.settings.portUnavailable")}
                </Text>
              </View>
              <AppIcon name="external-link" size={16} color={theme.colors.textMuted} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

function EnvironmentRow({ item, visible, onToggle, onCopy }: { item: EnvItem; visible: boolean; onToggle: () => void; onCopy: () => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.envItem, { borderBottomColor: theme.colors.border }]}>
      <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{item.name}</Text>
      <View style={styles.envValue}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("space.settings.copyValue")} onPress={onCopy} style={{ flex: 1 }}>
          <Text selectable={visible} numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted }]}>
            {visible ? item.value : "•".repeat(Math.min(24, Math.max(8, item.value.length)))}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? t("space.settings.hideValue") : t("space.settings.showValue")}
          onPress={onToggle}
          hitSlop={8}
        >
          <AppIcon name={visible ? "eye-off" : "eye"} size={17} color={theme.colors.textMuted} />
        </Pressable>
      </View>
    </View>
  );
}

function ActionButton({ label, icon, onPress, disabled = false }: { label: string; icon?: IconName; onPress: () => void; disabled?: boolean }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        {
          borderColor: theme.colors.borderStrong,
          backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      {icon ? <AppIcon name={icon} size={15} color={theme.colors.accent} /> : null}
      <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.text, flexShrink: 1 }]}>{label}</Text>
    </Pressable>
  );
}

function SegmentedControl<T extends string>({
  values,
  value,
  labels,
  maxValue,
  disabled,
  onChange,
  onLocked,
}: {
  values: readonly T[];
  value: T;
  labels: readonly string[];
  maxValue?: T;
  disabled?: boolean;
  onChange: (value: T) => void;
  onLocked?: () => void;
}) {
  const theme = useAppTheme();
  const max = maxValue ? Math.max(0, values.indexOf(maxValue)) : values.length - 1;
  return (
    <View
      accessibilityRole="radiogroup"
      style={[styles.segmented, { borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.background }]}
    >
      {values.map((item, index) => {
        const selected = item === value;
        const locked = index > max;
        const label = labels[index] ?? item;
        return (
          <Pressable
            key={item}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityState={{ selected, checked: selected, disabled: Boolean(disabled) }}
            aria-checked={selected}
            disabled={disabled}
            onPress={() => {
              if (locked) {
                onLocked?.();
                return;
              }
              if (item !== value) onChange(item);
            }}
            style={({ pressed }) => [
              styles.segment,
              index > 0 ? { borderLeftWidth: 1, borderLeftColor: theme.colors.borderStrong } : null,
              {
                backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : "transparent",
                opacity: locked ? 0.45 : 1,
              },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                typography.caption,
                { color: locked ? theme.colors.textFaint : selected ? theme.colors.accent : theme.colors.textSecondary },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function memberDisplayName(member: SpaceMember, fallback: string) {
  const displayName = member.profile?.displayName?.trim();
  const username = member.profile?.username?.trim();
  if (displayName && displayName !== member.userId) return displayName;
  if (username) return username;
  return fallback;
}

function roleLabel(role: SpaceRole, t: Translate) {
  if (role === "host") return t("space.settings.role.host");
  if (role === "builder") return t("space.settings.role.builder");
  return t("space.settings.role.guest");
}

function specNeedsRestart(config: SpaceSandboxConfig | null, pendingFromUpdate = false) {
  if (pendingFromUpdate) return true;
  if (!config) return false;
  if (config.specPendingRestart) return true;
  const spec = config.spec ?? "standard";
  return Boolean(config.appliedSpec && config.appliedSpec !== spec);
}

function sleepFromConfig(config: SpaceSandboxConfig | null) {
  if (config?.autoDestroy?.mode === "never") return "never";
  if (config?.autoDestroy?.ttlSeconds === 1800) return "0.5h";
  return "2h";
}

function sleepToPolicy(value: (typeof SLEEP_OPTIONS)[number]): SpaceSandboxAutoDestroyPolicy {
  if (value === "never") return { mode: "never" };
  return { mode: "idle", ttlSeconds: value === "0.5h" ? 1800 : 7200 };
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 26 },
  memberRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1 },
  memberCopy: { flex: 1, minWidth: 0, gap: 2 },
  inviteRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  actionButton: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderRadius: 12,
    borderCurve: "continuous",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  envRow: { flexDirection: "row", gap: 8, marginTop: 12, alignItems: "center" },
  field: { flex: 1, minHeight: 46, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12 },
  envAdd: { width: 46, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  envItem: { paddingVertical: 12, borderBottomWidth: 1, gap: 6 },
  envValue: { flexDirection: "row", alignItems: "center", gap: 8 },
  segmented: { marginTop: 10, minHeight: 40, borderWidth: 1, borderRadius: 12, borderCurve: "continuous", flexDirection: "row", overflow: "hidden" },
  segment: { flex: 1, minHeight: 40, paddingHorizontal: 8, alignItems: "center", justifyContent: "center" },
  restartRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 10 },
  restartBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  restartButton: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: 5 },
  portRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, marginTop: 8, borderRadius: 12 },
});
